import { afterEach, describe, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { headersFile } from '../scripts/build-headers.mjs';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true }); });
/** A complete export: the five fixed routes and the `_headers` scripts/build-headers.mjs writes (Task 23.6). */
function exportedSite(content = '<main>Cloudiator</main>', headers: string | null = headersFile(null)) {
  const directory = mkdtempSync(join(tmpdir(), 'cloudiator-static-'));
  directories.push(directory);
  for (const route of ['', 'game', 'auth/callback', 'replay', 'expedition']) {
    mkdirSync(join(directory, route), { recursive: true });
    writeFileSync(join(directory, route, 'index.html'), content);
  }
  if (headers !== null) writeFileSync(join(directory, '_headers'), headers);
  return directory;
}
function scan(directory: string, ...options: string[]) {
  return spawnSync(process.execPath, [resolve('scripts/verify-static.mjs'), directory, ...options], { encoding: 'utf8' });
}

test('scanner accepts a complete clean static export', () => {
  expect(scan(exportedSite()).status).toBe(0);
});

test('production config rejects the explicitly test-only identity key', () => {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '-e', "import('./next.config.ts')"], {
    encoding: 'utf8', env: { ...process.env, NODE_ENV: 'production', NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_browser_test_only' },
  });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('Test identity transport cannot be included in a production export');
});
test('scanner refuses a missing fixed route', () => {
  const directory = exportedSite();
  rmSync(join(directory, 'game/index.html'));
  expect(scan(directory).status).toBe(1);
});
test('scanner refuses an export without the fixed replay page', () => {
  const directory = exportedSite();
  rmSync(join(directory, 'replay/index.html'));
  expect(scan(directory).status).toBe(1);
});
test('scanner refuses an export without the fixed expedition page', () => {
  const directory = exportedSite();
  rmSync(join(directory, 'expedition/index.html'));
  const result = scan(directory);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Missing fixed route: expedition/index.html');
});
test('scanner accepts framework navigation seed references without private string inputs', () => {
  expect(scan(exportedSite('previousTree:i,url:t,nextUrl:r,seed:n; exitStatus:2,url:n,seed:null')).status).toBe(0);
});
test.each([
  String.raw`const payload = "{\"seed\":null}";`,
  String.raw`const payload = "\"{\\\"seed\\\":null}\"";`,
])('scanner accepts escaped JSON containing a null framework seed: %s', (content) => {
  expect(scan(exportedSite(content)).status).toBe(0);
});
test.each([
  String.raw`const payload = "{\"seed\":\"private-input\"}";`,
  String.raw`const payload = "{\"privateSeed\":\"private-input\"}";`,
  String.raw`const payload = "\"{\\\"seed\\\":\\\"private-input\\\"}\"";`,
  String.raw`const payload = "\"{\\\"privateSeed\\\":\\\"private-input\\\"}\"";`,
])('scanner refuses escaped JSON private seeds in a nested JavaScript asset: %s', (content) => {
  const directory = exportedSite();
  const asset = join(directory, '_next/static/chunks/payload.js');
  mkdirSync(join(directory, '_next/static/chunks'), { recursive: true });
  writeFileSync(asset, content);
  const result = scan(directory);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Forbidden backend material');
  expect(result.stderr).toContain('payload.js');
});
test.each([
  'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY', 'GAME_WORKER_SECRET',
  'sb_secret_example', '"seed":"private-input"', 'encounterPlan', 'futureOpponentSnapshot',
  'seed:"private-input"', 'encounter_plan', 'future_opponent_snapshot',
])('scanner refuses backend material in exported assets: %s', (secret) => {
  const result = scan(exportedSite(secret));
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Forbidden');
});
// Final review Minor 4: the fixture preview (its gateway and sample data) must never reach a production export. Every
// export the scanner checks is a production build, which forces NEXT_PUBLIC_FIXTURE_ENABLED off (next.config.ts),
// including the isolated `.next/browser-test` build.
test.each([
  'throw Object.assign(new Error("This read is unavailable in the fixture preview."),{code:"unavailable"})',
  'const s={receiptId:"fixture-receipt-pvp",settledAtMs:1}',
])('scanner refuses fixture preview data in an exported chunk: %s', (content) => {
  const directory = exportedSite();
  mkdirSync(join(directory, '_next/static/chunks'), { recursive: true });
  writeFileSync(join(directory, '_next/static/chunks/fixture.js'), content);
  const result = scan(directory);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Fixture preview data in _next');
  expect(result.stderr).toContain('fixture.js');
});
test('scanner accepts the production notice that refuses the fixture preview', () => {
  expect(scan(exportedSite('<p role="status">Fixture preview is unavailable in this build.</p>')).status).toBe(0);
});

// Task 23.6 (plan Decisions 2 and 7, C27): the release scan also checks the generated security headers, refuses the
// development-only art gallery, any JWT and base64-encoded service-role material. Every token below is built here and is
// obviously fake: no key, token or secret of any environment.
const base64url = (text: string) => Buffer.from(text).toString('base64url');
const FAKE_JWT = [base64url('{"alg":"none","typ":"JWT"}'), base64url('{"role":"fake-test-role","iss":"not-a-real-issuer"}'), 'fake-signature-for-tests'].join('.');
const PROJECT = 'https://abcdefghijklmnop.supabase.co';

describe('the security headers', () => {
  test('accepts the generated headers for the production project origin', () => {
    const result = scan(exportedSite(undefined, headersFile(PROJECT)));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`connect-src 'self' ${PROJECT}`);
  });

  // Task 24.1 (plan Decision 12): a deploy build is scanned with the origin it must connect to, so a build that picked up
  // another project's URL (or none) fails before it is published.
  test('with --origin, accepts exactly that connect-src origin, given as an origin or a project URL', () => {
    for (const origin of [PROJECT, `${PROJECT}/`]) {
      const result = scan(exportedSite(undefined, headersFile(PROJECT)), '--origin', origin);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(`connect-src 'self' ${PROJECT}, as required by --origin`);
    }
    // The option may come before the export folder too.
    const directory = exportedSite(undefined, headersFile(PROJECT));
    const first = spawnSync(process.execPath, [resolve('scripts/verify-static.mjs'), '--origin', PROJECT, directory], { encoding: 'utf8' });
    expect(first.status, first.stderr).toBe(0);
  });

  test.each([
    ['another project', headersFile(PROJECT), 'https://otherprojectabcdef.supabase.co',
      `connect-src names ${PROJECT}, not the required https://otherprojectabcdef.supabase.co`],
    ['a self-only export', headersFile(null), PROJECT, `connect-src names no origin, not the required ${PROJECT}`],
  ])('with --origin, refuses %s', (_name, headers, origin, message) => {
    const result = scan(exportedSite(undefined, headers), '--origin', origin);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
  });

  test.each([['an origin that is not a project or loopback URL', ['--origin', 'https://evil.example']], ['a missing value', ['--origin']],
    ['an unknown option', ['--origins', PROJECT]]])('refuses %s', (_name, options) => {
    const result = scan(exportedSite(undefined, headersFile(PROJECT)), ...options);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/--origin|Unknown option/);
  });

  test('refuses an export without _headers', () => {
    const result = scan(exportedSite(undefined, null));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Missing _headers');
  });

  test.each([
    ['a widened script-src', headersFile(null).replace("script-src 'self' 'unsafe-inline'", "script-src 'self' 'unsafe-inline' 'unsafe-eval'")],
    ['an unexpected connect-src origin', headersFile(null).replace("connect-src 'self'", "connect-src 'self' https://evil.example")],
    ['a missing nosniff header', headersFile(null).replace('  X-Content-Type-Options: nosniff\n', '')],
    ['no immutable caching for /_next/static/*', headersFile(null).replace(/\/_next\/static\/\*\n.*\n/, '')],
    ['a policy that is only reported', headersFile(null).replace('Content-Security-Policy:', 'Content-Security-Policy-Report-Only:')],
  ])('refuses %s', (_name, headers) => {
    const result = scan(exportedSite(undefined, headers));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('_headers');
  });
});

test('refuses the development-only art gallery in the export (plan Decision 2)', () => {
  const directory = exportedSite();
  mkdirSync(join(directory, 'assets'), { recursive: true });
  writeFileSync(join(directory, 'assets/gallery.html'), '<script>gallery()</script>');
  const result = scan(directory);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Development-only art gallery in the export: assets/gallery.html');
});

describe('JWT and base64 service-role material', () => {
  test('refuses a JWT in an exported chunk', () => {
    const directory = exportedSite();
    mkdirSync(join(directory, '_next/static/chunks'), { recursive: true });
    writeFileSync(join(directory, '_next/static/chunks/token.js'), `const key="${FAKE_JWT}";`);
    const result = scan(directory);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Forbidden backend material');
    expect(result.stderr).toContain('token.js');
  });

  // Fix round 1 (Minor): a token right after a percent-encoded or an escaped character (`Bearer%20eyJ…`, an escaped newline
  // before `eyJ…`) is preceded by a letter or digit, and is still a token. String.raw keeps each backslash as written.
  test.each([
    String.raw`fetch(u,{headers:{a:"Bearer%20${FAKE_JWT}"}})`,
    String.raw`const lines="first line\n${FAKE_JWT}";`,
    String.raw`const tabbed="key:\t${FAKE_JWT}";`,
    String.raw`const unicode="\u0022${FAKE_JWT}";`,
  ])('refuses a JWT after an encoded or escaped character: %s', (content) => {
    const result = scan(exportedSite(`<script>${content}</script>`));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Forbidden backend material');
  });

  // A base64 string has three alignments: the text can start at any byte offset modulo 3 of the encoded value.
  test.each(['', 'x', 'xy'].flatMap(prefix => (['base64', 'base64url'] as const).map(encoding => [prefix.length, encoding,
    Buffer.from(`${prefix}{"aud":"fake","role":"service_role"}`).toString(encoding)] as const)))(
    'refuses service_role encoded at offset %i (%s)', (_offset, _encoding, encoded) => {
      expect(encoded).not.toMatch(/service_role/i);
      const result = scan(exportedSite(`<script>const blob="${encoded}";</script>`));
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Forbidden backend material');
    });

  test.each([
    'data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbXX0=',
    `const role="${Buffer.from('{"role":"anon"}').toString('base64')}";`,
    'const dotted="eyJhIjoxfQ.notatoken";',
  ])('accepts base64 that is no token and no service role: %s', (content) => {
    expect(scan(exportedSite(content)).status).toBe(0);
  });
});
