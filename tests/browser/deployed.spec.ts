import { expect, test, type APIRequestContext, type APIResponse, type Page } from './fixtures';
import {
  ANON_PROBES, ATTESTED, FOREIGN_ORIGIN, ROUTES, attested, attestedProblems, authSettingsProblems, chunkReferences, compressionProblem,
  connectSrcProblems, consoleError, denialProblem, deployedOrigin, expectedHeaders, foreignPreflightProblems, headerMismatches, policyOrigin,
  preflightProblems, publishableKey, shippedProblems, supabaseOrigin, workerProblems, type AttestedCheck,
} from './deployed-checks';

// Task 24.2: the deployed acceptance checks (plan Decisions 1, 8 and 9; Tasks 24.5, 24.6 and 24.8). They run only with
// tests/browser/playwright.deployed.config.ts against the public origin in CLOUDIATOR_DEPLOYED_ORIGIN; the release gate's
// config ignores this file, and under any other config every check skips. No check signs in, uses an account, or sends a
// credential: the worker is asked without its secret, and the Data API and Auth are asked anonymously with the publishable
// key the deployed bundle itself carries (public by design), kept in memory and never printed.
// - Automatic (@automatic): fixedRoutesReload (also on the phone, @browser), securityHeaders, connectSrc, compression, cors,
//   anonDenied, authProvidersGoogleOnly, shippedAssetsClean. CLOUDIATOR_SUPABASE_ORIGIN is required by connectSrc, cors,
//   anonDenied and authProvidersGoogleOnly.
// - Attested (@attested): values Avi reads from scripts/hosted-checks.sql after the real journey, set as CLOUDIATOR_ATTEST_*.
//   Each fails, naming its variable and row, until it is set.
// Every page runs under the CSP-violation listener (tests/browser/fixtures.ts; the config sets `listenForCsp`).

const origin = process.env.CLOUDIATOR_DEPLOYED_ORIGIN ? deployedOrigin(process.env) : null;
test.skip(({ baseURL }) => !origin || baseURL !== origin,
  'The deployed checks run only with tests/browser/playwright.deployed.config.ts (docs/operations/runbook.md).');

const AUTOMATIC = { tag: '@automatic' };

/** The site's assets: the fixed routes' HTML and every chunk they reference, transitively; crawled once per worker. */
let shipped: Promise<Map<string, string>> | null = null;
function shippedAssets(request: APIRequestContext) {
  shipped ??= crawl(request).catch((error: unknown) => { shipped = null; throw error; });
  return shipped;
}
async function crawl(request: APIRequestContext) {
  const assets = new Map<string, string>();
  const queue = [...ROUTES];
  for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
    if (assets.has(path)) continue;
    const response = await request.get(path);
    if (response.status() !== 200) throw new Error(`${path}: status ${response.status()} while crawling the shipped assets`);
    const text = await response.text();
    assets.set(path, text);
    queue.push(...chunkReferences(text).filter(ref => !assets.has(ref)));
  }
  return assets;
}

/**
 * A request that carries the publishable key. Playwright's call log for a failed request lists its headers (observed: it
 * prints `apikey: …`), so a failure is rethrown with the first line of its message only, and the key masked as well. Each
 * request times out after 10 s, so the 14 probes fail inside the test's 180 s, never by the test timeout, whose report would
 * print the pending request's call log.
 */
async function keyed(request: APIRequestContext, url: string, options: Parameters<APIRequestContext['fetch']>[1] & { method: string }, key: string): Promise<APIResponse> {
  try { return await request.fetch(url, { ...options, timeout: 10_000 }); } catch (error) {
    const first = String(error instanceof Error ? error.message : error).split('\n')[0].replaceAll(key, '<publishable key>');
    throw new Error(`${options.method} ${new URL(url).pathname}: ${first}`);
  }
}

/**
 * Console errors and uncaught exceptions of `page`, each named with the path it happened on (consoleError). The browser's
 * request for the missing site icon is recorded as an annotation instead.
 */
function watchErrors(page: Page) {
  const errors: string[] = [], recorded: string[] = [];
  const where = () => { try { return new URL(page.url()).pathname; } catch { return page.url(); } };
  page.on('console', message => {
    if (message.type() !== 'error') return;
    const problem = consoleError(where(), message.text(), message.location().url, origin!);
    if (problem) errors.push(problem); else recorded.push(`${where()}: /favicon.ico answered 404 (the site has no icon)`);
  });
  page.on('pageerror', error => errors.push(`${where()}: uncaught ${error.name}: ${error.message}`));
  return { errors, recorded };
}
/** Waits until a route's page has rendered past its loading fallback, and its requests have settled where they do. */
async function rendered(page: Page, path: string) {
  await expect(page.locator('main#main'), `${path}: the page's main landmark`).toBeVisible();
  await expect(page.locator('main#main.loading'), `${path}: past the loading fallback`).toHaveCount(0);
  // A page that keeps a connection open never goes idle; its errors so far are still collected.
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
}

test.describe('deployedChecks (automatic)', () => {
  test('fixedRoutesReload', { tag: ['@automatic', '@browser'] }, async ({ page }) => {
    const { errors, recorded } = watchErrors(page);
    for (const path of ROUTES) {
      const first = await page.goto(path);
      expect(first?.status(), path).toBe(200);
      await rendered(page, path);
      const again = await page.reload();
      expect(again?.status(), `${path} after a reload`).toBe(200);
      await rendered(page, path);
    }
    for (const note of recorded) test.info().annotations.push({ type: 'recorded', description: note });
    expect(errors).toEqual([]);
  });

  test('securityHeaders', AUTOMATIC, async ({ request }) => {
    const assets = await shippedAssets(request);
    const chunk = [...assets.keys()].find(path => path.startsWith('/_next/static/'));
    expect(chunk, 'a /_next/static/ chunk the routes reference').toBeDefined();
    // The expected headers are those the generated `_headers` gives each path, for the origin the served policy names
    // (connectSrc checks that origin).
    const problems: string[] = [];
    let connect: string | null = null;
    try { connect = policyOrigin((await request.get('/')).headers()['content-security-policy'] ?? ''); } catch (error) { problems.push(`/: ${(error as Error).message}`); }
    test.info().annotations.push({ type: 'connect-src', description: connect ?? "'self' only" });
    for (const path of [...ROUTES, chunk!]) {
      const response = await request.get(path);
      expect(response.status(), path).toBe(200);
      problems.push(...headerMismatches(path, expectedHeaders(connect, path), response.headers()));
    }
    expect(problems).toEqual([]);
  });

  test('connectSrc', AUTOMATIC, async ({ request }) => {
    const required = supabaseOrigin(process.env);
    const problems: string[] = [];
    for (const path of ROUTES) problems.push(...connectSrcProblems(path, (await request.get(path)).headers()['content-security-policy'] ?? '', required));
    expect(problems).toEqual([]);
  });

  test('compression', AUTOMATIC, async ({ request }) => {
    const assets = await shippedAssets(request);
    const paths = [...ROUTES, ...[...assets.keys()].filter(path => path.endsWith('.js'))];
    const problems: string[] = [];
    for (const path of paths) {
      const problem = compressionProblem(path, (await request.get(path, { headers: { 'Accept-Encoding': 'br, gzip' } })).headers());
      if (problem) problems.push(problem);
    }
    test.info().annotations.push({ type: 'compression', description: `${paths.length - problems.length} of ${paths.length} responses br or gzip` });
    expect(problems).toEqual([]);
  });

  test('cors', AUTOMATIC, async ({ request }) => {
    const supabase = supabaseOrigin(process.env);
    const preflight = async (from: string) => {
      const response = await request.fetch(`${supabase}/functions/v1/game-command`, { method: 'OPTIONS', timeout: 30_000, headers: {
        Origin: from, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization, apikey, content-type, x-client-info' } });
      return { status: response.status(), headers: response.headers() };
    };
    // The worker without its secret: no Authorization header at all, and no key.
    const worker = await request.post(`${supabase}/functions/v1/game-worker`, { timeout: 30_000 });
    expect([
      ...preflightProblems(await preflight(origin!), origin!),
      ...foreignPreflightProblems(await preflight(FOREIGN_ORIGIN)),
      ...workerProblems(worker.status(), await worker.text()),
    ]).toEqual([]);
  });

  test('anonDenied', AUTOMATIC, async ({ request }) => {
    const supabase = supabaseOrigin(process.env);
    const key = publishableKey(await shippedAssets(request));
    const problems: string[] = [];
    for (const probe of ANON_PROBES) {
      const headers: Record<string, string> = { apikey: key, Prefer: 'return=minimal' };
      if (probe.body) headers['Content-Type'] = 'application/json';
      if (probe.profile) headers[probe.method === 'GET' ? 'Accept-Profile' : 'Content-Profile'] = probe.profile;
      const response = await keyed(request, `${supabase}${probe.path}`, { method: probe.method, headers,
        data: probe.body ? JSON.stringify(probe.body) : undefined }, key);
      const problem = denialProblem(probe, response.status(), await response.text());
      if (problem) problems.push(problem);
    }
    expect(problems).toEqual([]);
  });

  test('authProvidersGoogleOnly', AUTOMATIC, async ({ request }) => {
    const supabase = supabaseOrigin(process.env);
    const key = publishableKey(await shippedAssets(request));
    const response = await keyed(request, `${supabase}/auth/v1/settings`, { method: 'GET', headers: { apikey: key } }, key);
    expect(response.status(), 'GET /auth/v1/settings').toBe(200);
    let settings: unknown = null;
    try { settings = JSON.parse(await response.text()); } catch { /* named below */ }
    expect(authSettingsProblems(settings)).toEqual([]);
  });

  test('shippedAssetsClean', AUTOMATIC, async ({ page, request }) => {
    const assets = new Map(await shippedAssets(request));
    // Beyond the static references: everything of the site's own the routes load in the browser (scripts, data payloads).
    const loaded = new Set<string>();
    page.on('response', response => {
      const url = new URL(response.url());
      if (url.origin === origin && ['document', 'script', 'fetch', 'xhr'].includes(response.request().resourceType())) loaded.add(url.pathname + url.search);
    });
    for (const path of ROUTES) {
      await page.goto(path);
      await rendered(page, path);
    }
    for (const path of loaded) {
      if (assets.has(path)) continue;
      const response = await request.get(path);
      if (response.ok()) assets.set(path, await response.text());
    }
    const scripts = [...assets.keys()].filter(path => /\.js(?:\?|$)/.test(path)).length;
    test.info().annotations.push({ type: 'scanned', description: `${assets.size} assets, ${scripts} of them JavaScript` });
    expect([...assets].flatMap(([path, text]) => shippedProblems(path, text))).toEqual([]);
  });
});

test.describe('deployedChecks (attested by Avi, plan Decision 8)', () => {
  for (const check of Object.keys(ATTESTED) as AttestedCheck[]) {
    const fields = Object.values(ATTESTED[check]) as { env: string; row: string }[];
    test(check, { tag: '@attested', annotation: { type: 'attested', description: fields.map(f => `${f.env} from "${f.row}"`).join('; ') } }, () => {
      expect(attestedProblems(check, attested(check, process.env))).toEqual([]);
    });
  }
});
