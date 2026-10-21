import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { IMMUTABLE, PERMISSIONS_POLICY, contentSecurityPolicy } from '../scripts/build-headers.mjs';
import { FIXED_ROUTES } from '../scripts/release-scan.mjs';
import {
  ANON_PROBES, ATTESTED, FOREIGN_ORIGIN, ROUTES, attested, attestedProblems, authSettingsProblems, chunkReferences,
  compressionProblem, connectSrcProblems, consoleError, denialProblem, deployedOrigin, expectedHeaders, foreignPreflightProblems,
  headerMismatches, parseCsp, policyOrigin, preflightProblems, publishableKey, shippedProblems, supabaseOrigin, workerProblems,
} from './browser/deployed-checks.ts';

// Task 24.2 (plan Decisions 1, 8 and 9): the pure pieces of the deployed acceptance checks (tests/browser/deployed.spec.ts),
// and the configs that keep them out of the release gate. Every key, token and origin below is made up here: no key of any
// environment is used, and no request leaves this process.

const SITE = 'https://cloudiator.pages.dev';
const PROJECT = 'https://abcdefghijklmnop.supabase.co';
const base64url = (text: string) => Buffer.from(text).toString('base64url');
const FAKE_JWT = [base64url('{"alg":"none","typ":"JWT"}'), base64url('{"role":"fake-test-role"}'), 'fake-signature-for-tests'].join('.');
const FAKE_KEY = 'sb_publishable_fakeKeyForUnitTests_0123456789';

describe('the environment', () => {
  it('requires the deployed origin and never guesses one', () => {
    for (const env of [{}, { CLOUDIATOR_DEPLOYED_ORIGIN: '' }, { CLOUDIATOR_DEPLOYED_ORIGIN: '  ' }]) {
      expect(() => deployedOrigin(env)).toThrow(/CLOUDIATOR_DEPLOYED_ORIGIN is not set.*never guess/s);
    }
  });

  it('takes an https origin, or a loopback http origin for a local stand-in', () => {
    expect(deployedOrigin({ CLOUDIATOR_DEPLOYED_ORIGIN: SITE })).toBe(SITE);
    expect(deployedOrigin({ CLOUDIATOR_DEPLOYED_ORIGIN: `${SITE}/` })).toBe(SITE);
    expect(deployedOrigin({ CLOUDIATOR_DEPLOYED_ORIGIN: 'http://127.0.0.1:4580' })).toBe('http://127.0.0.1:4580');
    expect(deployedOrigin({ CLOUDIATOR_DEPLOYED_ORIGIN: 'http://localhost:4580/' })).toBe('http://localhost:4580');
  });

  it.each(['cloudiator.pages.dev', 'http://cloudiator.pages.dev', `${SITE}/game/`, `${SITE}/?x=1`, `${SITE}/#top`,
    'https://user:pass@cloudiator.pages.dev', 'ftp://cloudiator.pages.dev', 'http://10.0.0.5:4580'])('refuses the deployed origin %s', (value) => {
    expect(() => deployedOrigin({ CLOUDIATOR_DEPLOYED_ORIGIN: value })).toThrow(/CLOUDIATOR_DEPLOYED_ORIGIN/);
  });

  it('requires the Supabase origin for the checks that use it, a hosted project or the local stack', () => {
    expect(() => supabaseOrigin({})).toThrow(/CLOUDIATOR_SUPABASE_ORIGIN is not set.*never guess/s);
    expect(supabaseOrigin({ CLOUDIATOR_SUPABASE_ORIGIN: PROJECT })).toBe(PROJECT);
    expect(supabaseOrigin({ CLOUDIATOR_SUPABASE_ORIGIN: `${PROJECT}/` })).toBe(PROJECT);
    expect(supabaseOrigin({ CLOUDIATOR_SUPABASE_ORIGIN: 'http://127.0.0.1:54321' })).toBe('http://127.0.0.1:54321');
    for (const value of ['https://evil.example', 'http://abcdefghijklmnop.supabase.co', 'not a url']) {
      expect(() => supabaseOrigin({ CLOUDIATOR_SUPABASE_ORIGIN: value }), value).toThrow(/CLOUDIATOR_SUPABASE_ORIGIN/);
    }
  });
});

describe('the fixed routes', () => {
  it('are the release scan\'s five routes, as URL paths', () => {
    expect(FIXED_ROUTES).toEqual(['index.html', 'game/index.html', 'auth/callback/index.html', 'replay/index.html', 'expedition/index.html']);
    expect(ROUTES).toEqual(['/', '/game/', '/auth/callback/', '/replay/', '/expedition/']);
  });
});

describe('fixedRoutesReload\'s console errors', () => {
  const NOT_FOUND = 'Failed to load resource: the server responded with a status of 404 (Not Found)';

  it('names the resource a failed load was for, by path', () => {
    expect(consoleError('/replay/', NOT_FOUND, `${SITE}/game/__next.game.__PAGE__.txt?_rsc=abc`, SITE))
      .toBe(`/replay/: console error: ${NOT_FOUND} (/game/__next.game.__PAGE__.txt)`);
    expect(consoleError('/game/', 'TypeError: x is undefined', `${SITE}/_next/static/chunks/a.js`, SITE)).toBe('/game/: console error: TypeError: x is undefined');
  });

  it('records the browser\'s own request for the missing site icon instead of failing on it', () => {
    expect(consoleError('/', NOT_FOUND, `${SITE}/favicon.ico`, SITE)).toBeNull();
    // Anything else about the icon, or another site's icon, still fails.
    expect(consoleError('/', NOT_FOUND.replace('404 (Not Found)', '500 (Internal Server Error)'), `${SITE}/favicon.ico`, SITE)).not.toBeNull();
    expect(consoleError('/', NOT_FOUND, 'https://other.example/favicon.ico', SITE)).not.toBeNull();
    expect(consoleError('/', NOT_FOUND, `${SITE}/assets/favicon.ico`, SITE)).not.toBeNull();
  });
});

describe('securityHeaders', () => {
  const page = { 'content-security-policy': contentSecurityPolicy(PROJECT), 'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin', 'permissions-policy': PERMISSIONS_POLICY };

  it('expects on each path exactly the headers the generated _headers gives it', () => {
    expect(expectedHeaders(PROJECT, '/game/')).toEqual(page);
    expect(expectedHeaders(PROJECT, '/_next/static/chunks/app.js')).toEqual({ ...page, 'cache-control': IMMUTABLE });
    expect(expectedHeaders(null, '/')['content-security-policy']).toBe(contentSecurityPolicy(null));
  });

  it('accepts a response with those headers and any others', () => {
    expect(headerMismatches('/game/', page, { ...page, 'content-type': 'text/html', 'cache-control': 'public, max-age=0, must-revalidate' })).toEqual([]);
  });

  it('names a missing, changed or repeated header', () => {
    const { 'x-content-type-options': _, ...missing } = page;
    expect(headerMismatches('/game/', page, missing)).toEqual(['/game/: x-content-type-options missing (expected nosniff)']);
    expect(headerMismatches('/game/', page, { ...page, 'referrer-policy': 'no-referrer' }))
      .toEqual(['/game/: referrer-policy is no-referrer, expected strict-origin-when-cross-origin']);
    // A host that adds its own copy of a header joins the two: still a difference, to be judged with evidence.
    expect(headerMismatches('/game/', page, { ...page, 'x-content-type-options': 'nosniff, nosniff' }))
      .toEqual(['/game/: x-content-type-options is nosniff, nosniff, expected nosniff']);
  });

  it('refuses immutable caching outside /_next/static/', () => {
    expect(headerMismatches('/game/', page, { ...page, 'cache-control': IMMUTABLE }))
      .toEqual([`/game/: cache-control is ${IMMUTABLE} outside /_next/static/`]);
  });

  it('reads the connect-src origin the policy names, if any, and refuses one no build would write', () => {
    expect(policyOrigin(contentSecurityPolicy(PROJECT))).toBe(PROJECT);
    expect(policyOrigin(contentSecurityPolicy(null))).toBeNull();
    expect(() => policyOrigin(contentSecurityPolicy(null).replace("connect-src 'self'", "connect-src 'self' https://evil.example"))).toThrow(/connect-src/);
    expect(() => policyOrigin(contentSecurityPolicy(PROJECT).replace(PROJECT, `${PROJECT} http://127.0.0.1:54321`))).toThrow(/connect-src/);
    expect(() => policyOrigin("default-src 'self'")).toThrow(/connect-src/);
  });
});

describe('the policy parser and connectSrc', () => {
  it('parses directives and their sources', () => {
    const csp = parseCsp(` default-src 'self';CONNECT-SRC  'self'   ${PROJECT} ;; img-src 'self' data: `);
    expect([...csp]).toEqual([['default-src', ["'self'"]], ['connect-src', ["'self'", PROJECT]], ['img-src', ["'self'", 'data:']]]);
    // A repeated directive is ignored by browsers after its first occurrence.
    expect(parseCsp("connect-src 'self'; connect-src *").get('connect-src')).toEqual(["'self'"]);
  });

  it('accepts exactly the site and the required project in connect-src', () => {
    expect(connectSrcProblems('/', contentSecurityPolicy(PROJECT), PROJECT)).toEqual([]);
  });

  it.each([
    ['no project', contentSecurityPolicy(null), `/: connect-src is 'self', expected 'self' ${PROJECT}`],
    ['another project', contentSecurityPolicy('https://otherprojectabcdef.supabase.co'),
      `/: connect-src is 'self' https://otherprojectabcdef.supabase.co, expected 'self' ${PROJECT}`],
    ['a wildcard as well', contentSecurityPolicy(PROJECT).replace(PROJECT, `${PROJECT} *`), `/: connect-src is 'self' ${PROJECT} *, expected 'self' ${PROJECT}`],
    ['no policy', '', '/: no connect-src (no Content-Security-Policy)'],
  ])('names %s', (_name, policy, problem) => {
    expect(connectSrcProblems('/', policy, PROJECT)).toEqual([problem]);
  });
});

describe('compression', () => {
  it('accepts br and gzip', () => {
    expect(compressionProblem('/', { 'content-encoding': 'br' })).toBeNull();
    expect(compressionProblem('/a.js', { 'content-encoding': 'gzip' })).toBeNull();
  });

  it('names an uncompressed or otherwise encoded response', () => {
    expect(compressionProblem('/', {})).toBe('/: not compressed (no content-encoding)');
    expect(compressionProblem('/a.js', { 'content-encoding': 'zstd' })).toBe('/a.js: content-encoding zstd, expected br or gzip');
  });
});

describe('cors', () => {
  const granted = { 'access-control-allow-origin': SITE, 'access-control-max-age': '7200' };

  it('accepts the exact-origin grant, cached for 7200 s, as 204 or 200', () => {
    expect(preflightProblems({ status: 204, headers: granted }, SITE)).toEqual([]);
    expect(preflightProblems({ status: 200, headers: granted }, SITE)).toEqual([]);
  });

  it.each([
    ['a refusal', { status: 401, headers: granted }, 'preflight from the site: status 401, expected 204 or 200'],
    ['a wildcard grant', { status: 204, headers: { ...granted, 'access-control-allow-origin': '*' } }, 'preflight from the site: grants every origin (*)'],
    ['no grant', { status: 204, headers: { 'access-control-max-age': '7200' } }, 'preflight from the site: no Access-Control-Allow-Origin, expected the site'],
    ['another grant', { status: 204, headers: { ...granted, 'access-control-allow-origin': 'https://other.pages.dev' } },
      'preflight from the site: grants https://other.pages.dev, expected the site'],
    ['no cache time', { status: 204, headers: { 'access-control-allow-origin': SITE } }, 'preflight from the site: Access-Control-Max-Age missing, expected 7200'],
    ['a shorter cache time', { status: 204, headers: { ...granted, 'access-control-max-age': '600' } }, 'preflight from the site: Access-Control-Max-Age 600, expected 7200'],
  ])('names %s', (_name, response, problem) => {
    expect(preflightProblems(response, SITE)).toEqual([problem]);
  });

  it('expects no grant, and 403, for another origin', () => {
    expect(foreignPreflightProblems({ status: 403, headers: {} })).toEqual([]);
    expect(foreignPreflightProblems({ status: 204, headers: { 'access-control-allow-origin': FOREIGN_ORIGIN } }))
      .toEqual(['preflight from another origin: status 204, expected 403', `preflight from another origin: grants ${FOREIGN_ORIGIN}`]);
    expect(foreignPreflightProblems({ status: 403, headers: { 'access-control-allow-origin': '*' } })).toEqual(['preflight from another origin: grants *']);
  });

  it('expects the worker to refuse a request without its secret with 401 unauthenticated, and prints no body', () => {
    expect(workerProblems(401, '{"ok":false,"code":"unauthenticated"}')).toEqual([]);
    expect(workerProblems(200, '{"ok":true,"dispatched":3,"detail":"private"}')).toEqual(['game-worker without its secret: status 200, code none, expected 401 unauthenticated']);
    expect(workerProblems(401, '{"message":"Invalid JWT"}')).toEqual(['game-worker without its secret: status 401, code none, expected 401 unauthenticated']);
    expect(workerProblems(503, 'gateway text')).toEqual(['game-worker without its secret: status 503, code none, expected 401 unauthenticated']);
  });
});

describe('anonDenied', () => {
  it('probes backend-only functions with null arguments, table writes that match no row, and the private schema', () => {
    const rpcs = ANON_PROBES.filter(p => p.path.startsWith('/rest/v1/rpc/') && !p.profile).map(p => p.path.slice('/rest/v1/rpc/'.length));
    expect(rpcs).toEqual(['create_gladiator', 'edit_schedule', 'buy_listing', 'claim_jobs', 'complete_job', 'renew_job', 'settle_activity']);
    for (const probe of ANON_PROBES.filter(p => p.path.startsWith('/rest/v1/rpc/'))) {
      expect(Object.values(probe.body ?? {}).every(value => value === null), probe.label).toBe(true);
    }
    // Updates and deletes filter on `is.null` of a key column, so even a granted privilege would change no row.
    for (const probe of ANON_PROBES.filter(p => p.method === 'PATCH' || p.method === 'DELETE')) expect(probe.path, probe.label).toMatch(/\?\w+=is\.null$/);
    expect(ANON_PROBES.filter(p => p.method === 'POST' && !p.path.includes('/rpc/')).map(p => p.label))
      .toEqual(['insert wallets', 'insert item_instances', 'insert world_actors']);
    expect(ANON_PROBES.filter(p => p.profile === 'private').map(p => p.expected)).toEqual([['PGRST106'], ['PGRST106']]);
  });

  const rpc = ANON_PROBES.find(p => p.label === 'rpc claim_jobs')!;
  const exposure = ANON_PROBES.find(p => p.profile === 'private')!;

  it('accepts a refusal for want of the privilege, and the private schema left unexposed', () => {
    expect(denialProblem(rpc, 401, '{"code":"42501","message":"permission denied for function claim_jobs"}')).toBeNull();
    expect(denialProblem(rpc, 403, '{"code":"42501"}')).toBeNull();
    expect(denialProblem(exposure, 406, '{"code":"PGRST106","message":"Invalid schema: private"}')).toBeNull();
  });

  it('names anything else by status and code only, never the response text', () => {
    expect(denialProblem(rpc, 200, '[{"id":"secret-row"}]')).toBe('rpc claim_jobs: status 200, code none, expected 42501');
    expect(denialProblem(rpc, 404, '{"code":"PGRST202","message":"Could not find the function"}')).toBe('rpc claim_jobs: status 404, code PGRST202, expected 42501');
    expect(denialProblem(exposure, 200, '[]')).toBe(`${exposure.label}: status 200, code none, expected PGRST106`);
    expect(denialProblem(rpc, 400, '{"code":"22023","message":"invalid claim"}')).toBe('rpc claim_jobs: status 400, code 22023, expected 42501');
  });
});

describe('authProvidersGoogleOnly', () => {
  const settings = { external: { anonymous_users: false, apple: false, email: false, github: false, google: true, phone: false }, disable_signup: false };

  it('accepts Google alone, with sign-up open for new Google accounts', () => {
    expect(authSettingsProblems(settings)).toEqual([]);
  });

  it('names every other provider that is on, Google off, and closed sign-up', () => {
    expect(authSettingsProblems({ ...settings, external: { ...settings.external, email: true, anonymous_users: true, phone: true } }))
      .toEqual(['enabled besides Google: anonymous_users, email, phone']);
    expect(authSettingsProblems({ ...settings, external: { ...settings.external, google: false } })).toEqual(['Google is not enabled']);
    expect(authSettingsProblems({ ...settings, disable_signup: true })).toEqual(['sign-up is disabled: a new Google account cannot join']);
    expect(authSettingsProblems({ disable_signup: false })).toEqual(['no external providers in /auth/v1/settings']);
    expect(authSettingsProblems('not json')).toEqual(['no external providers in /auth/v1/settings']);
  });
});

describe('shippedAssetsClean', () => {
  it('follows the chunk references in HTML and JavaScript, the site\'s own only', () => {
    const html = '<script src="/_next/static/chunks/0au-j3z6bz51c.js" async></script><link href="/_next/static/chunks/a.css">';
    const js = 'e.v(t=>Promise.all(["static/chunks/32qu1ao7-m8lh.js","static/chunks/38ysc3s70xsof.js"].map(t=>e.l(t))))'
      + ';load("https://cdn.example/_next/static/chunks/other.js")';
    expect(chunkReferences(html)).toEqual(['/_next/static/chunks/0au-j3z6bz51c.js']);
    expect(chunkReferences(js)).toEqual(['/_next/static/chunks/32qu1ao7-m8lh.js', '/_next/static/chunks/38ysc3s70xsof.js']);
    expect(chunkReferences('"/_next/static/chunks/x.js","/_next/static/chunks/x.js"')).toEqual(['/_next/static/chunks/x.js']);
  });

  it('applies the release scan\'s patterns and the browser-test key to each asset, naming the asset only', () => {
    expect(shippedProblems('/game/', '<main>Cloudiator</main><script>s.startsWith("sb_publishable_")</script>')).toEqual([]);
    expect(shippedProblems('/_next/static/chunks/a.js', `const k="${FAKE_JWT}"`)).toEqual(['/_next/static/chunks/a.js: forbidden backend material']);
    expect(shippedProblems('/a.js', 'SUPABASE_SERVICE_ROLE_KEY')).toEqual(['/a.js: forbidden backend material']);
    expect(shippedProblems('/a.js', 'const s={receiptId:"fixture-receipt-pvp"}')).toEqual(['/a.js: fixture preview data']);
    expect(shippedProblems('/a.js', 'const k="sb_publishable_browser_test_only"')).toEqual(['/a.js: the browser-test key']);
    expect(shippedProblems('/a.js', 'const k="sb_secret_fakeForUnitTests"')).toEqual(['/a.js: forbidden backend material']);
  });

  it('finds the one publishable key in the bundle, and names a problem without the key', () => {
    const one = new Map([['/a.js', `x.startsWith("sb_publishable_");createClient(u,"${FAKE_KEY}")`], ['/b.js', `"${FAKE_KEY}"`]]);
    expect(publishableKey(one)).toBe(FAKE_KEY);
    expect(() => publishableKey(new Map([['/a.js', 'x.startsWith("sb_publishable_")']]))).toThrow('no publishable key (sb_publishable_…) in the deployed bundle');
    const two = new Map([['/a.js', `"${FAKE_KEY}"`], ['/b.js', `"${FAKE_KEY}x"`]]);
    expect(() => publishableKey(two)).toThrow('2 different publishable keys in the deployed bundle');
    expect(() => publishableKey(new Map([['/a.js', '"sb_publishable_browser_test_only"']]))).toThrow('the browser-test key is in the deployed bundle');
    for (const bundle of [two]) {
      try { publishableKey(bundle); } catch (error) { expect(String(error)).not.toContain(FAKE_KEY); }
    }
  });
});

describe('the attested checks', () => {
  it('are the three of plan Task 24.2, each read from its hosted-checks.sql rows', () => {
    expect(Object.keys(ATTESTED)).toEqual(['persistedCharactersForNewGoogleAccount', 'completedRealBoundary', 'twoAccountTrade']);
    expect(Object.values(ATTESTED).flatMap(fields => Object.values(fields).map(f => f.env))).toEqual([
      'CLOUDIATOR_ATTEST_NEW_ACCOUNT_CHARACTERS', 'CLOUDIATOR_ATTEST_BOUNDARIES_COMPLETED', 'CLOUDIATOR_ATTEST_BOUNDARIES_OVER_120S',
      'CLOUDIATOR_ATTEST_DUPLICATE_GRANTS', 'CLOUDIATOR_ATTEST_TRADE_OWNERS', 'CLOUDIATOR_ATTEST_TRADE_FEE_CORRECT']);
  });

  it('fail clearly while a value is not attested', () => {
    expect(() => attested('completedRealBoundary', { CLOUDIATOR_ATTEST_DUPLICATE_GRANTS: '0' }))
      .toThrow(/not attested: CLOUDIATOR_ATTEST_BOUNDARIES_COMPLETED is not set.*hosted-checks\.sql.*boundary-latency \/ last 24 h boundaries/s);
  });

  it('refuse a value that is not a whole number or true/false', () => {
    expect(() => attested('persistedCharactersForNewGoogleAccount', { CLOUDIATOR_ATTEST_NEW_ACCOUNT_CHARACTERS: 'one' })).toThrow(/not a whole number/);
    expect(() => attested('persistedCharactersForNewGoogleAccount', { CLOUDIATOR_ATTEST_NEW_ACCOUNT_CHARACTERS: '-1' })).toThrow(/not a whole number/);
    expect(() => attested('twoAccountTrade', { CLOUDIATOR_ATTEST_TRADE_OWNERS: '1', CLOUDIATOR_ATTEST_TRADE_FEE_CORRECT: 'yes' })).toThrow(/true or false/);
  });

  it('compare the attested values with the acceptance values', () => {
    const boundary = { CLOUDIATOR_ATTEST_BOUNDARIES_COMPLETED: '1', CLOUDIATOR_ATTEST_BOUNDARIES_OVER_120S: '0', CLOUDIATOR_ATTEST_DUPLICATE_GRANTS: ' 0 ' };
    expect(attestedProblems('completedRealBoundary', attested('completedRealBoundary', boundary))).toEqual([]);
    expect(attestedProblems('completedRealBoundary', attested('completedRealBoundary', { ...boundary, CLOUDIATOR_ATTEST_DUPLICATE_GRANTS: '2',
      CLOUDIATOR_ATTEST_BOUNDARIES_COMPLETED: '0' }))).toEqual(['boundaries is 0, expected at least 1', 'duplicateGrants is 2, expected 0']);
    expect(attestedProblems('persistedCharactersForNewGoogleAccount',
      attested('persistedCharactersForNewGoogleAccount', { CLOUDIATOR_ATTEST_NEW_ACCOUNT_CHARACTERS: '2' }))).toEqual(['characters is 2, expected 1']);
    expect(attestedProblems('twoAccountTrade', attested('twoAccountTrade', { CLOUDIATOR_ATTEST_TRADE_OWNERS: '1', CLOUDIATOR_ATTEST_TRADE_FEE_CORRECT: 'false' })))
      .toEqual(['feeCorrect is false, expected true']);
  });
});

// The release gate never runs the deployed checks: `npm run verify` runs the repository config in both modes (development, and
// PLAYWRIGHT_STATIC=true for the production gate), and both ignore deployed.spec.ts. Playwright itself loads each config and
// lists the tests it would run; nothing starts a server or a browser.
const DEPLOYED_ENV = ['CLOUDIATOR_DEPLOYED_ORIGIN', 'CLOUDIATOR_SUPABASE_ORIGIN'];
function listed(args: string[], env: Record<string, string>) {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env };
  for (const name of [...DEPLOYED_ENV, 'PLAYWRIGHT_STATIC'].filter(name => !(name in env))) delete childEnv[name];
  return new Promise<{ status: number | null; files: string[]; stderr: string }>((done) => {
    const child = spawn(process.execPath, [resolve('node_modules/@playwright/test/cli.js'), 'test', '--list', '--reporter=json', ...args], { env: childEnv });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', status => {
      type Suite = { file?: string; suites?: Suite[] };
      const files = new Set<string>();
      const walk = (suites: Suite[] = []) => { for (const suite of suites) { if (suite.file) files.add(suite.file.replace(/\\/g, '/')); walk(suite.suites); } };
      try { walk((JSON.parse(stdout) as { suites: Suite[] }).suites); } catch { /* status and stderr tell */ }
      done({ status, files: [...files].sort(), stderr });
    });
  });
}

describe('the Playwright configs', () => {
  it('keep deployed.spec.ts out of both release gate modes, and the deployed config runs it alone', { timeout: 120_000 }, async () => {
    const [development, production, deployed, unset] = await Promise.all([
      listed([], {}),
      listed([], { PLAYWRIGHT_STATIC: 'true' }),
      listed(['--config', 'tests/browser/playwright.deployed.config.ts'], { CLOUDIATOR_DEPLOYED_ORIGIN: SITE }),
      listed(['--config', 'tests/browser/playwright.deployed.config.ts'], {}),
    ]);
    for (const [mode, run] of [['development', development], ['production', production]] as const) {
      expect(run.status, `${mode}: ${run.stderr}`).toBe(0);
      expect(run.files, mode).toContain('csp.spec.ts');
      expect(run.files.length, mode).toBeGreaterThan(20);
      expect(run.files, mode).not.toContain('deployed.spec.ts');
    }
    expect(deployed.status, deployed.stderr).toBe(0);
    expect(deployed.files).toEqual(['deployed.spec.ts']);
    // Without an origin the deployed config refuses to load, naming the variable, instead of guessing one.
    expect(unset.status).not.toBe(0);
    expect(unset.stderr).toContain('CLOUDIATOR_DEPLOYED_ORIGIN is not set');
  });

  it('points the deployed config at the origin, with the CSP listener on, no web server and no traces', async () => {
    const previous = process.env.CLOUDIATOR_DEPLOYED_ORIGIN;
    process.env.CLOUDIATOR_DEPLOYED_ORIGIN = `${SITE}/`;
    try {
      const { default: config } = await import('./browser/playwright.deployed.config.ts');
      expect(config.use).toMatchObject({ baseURL: SITE, listenForCsp: true, trace: 'off', screenshot: 'off', video: 'off' });
      expect(config.webServer).toBeUndefined();
      expect(config.projects?.map(p => p.name)).toEqual(['desktop', 'mobile']);
    } finally {
      if (previous === undefined) delete process.env.CLOUDIATOR_DEPLOYED_ORIGIN; else process.env.CLOUDIATOR_DEPLOYED_ORIGIN = previous;
    }
  });
});
