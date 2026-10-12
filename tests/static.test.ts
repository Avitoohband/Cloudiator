import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true }); });
function exportedSite(content = '<main>Cloudiator</main>') {
  const directory = mkdtempSync(join(tmpdir(), 'cloudiator-static-'));
  directories.push(directory);
  for (const route of ['', 'game', 'auth/callback', 'replay']) {
    mkdirSync(join(directory, route), { recursive: true });
    writeFileSync(join(directory, route, 'index.html'), content);
  }
  return directory;
}
function scan(directory: string) {
  return spawnSync(process.execPath, [resolve('scripts/verify-static.mjs'), directory], { encoding: 'utf8' });
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
test('scanner accepts framework navigation seed references without private string inputs', () => {
  expect(scan(exportedSite('previousTree:i,url:t,nextUrl:r,seed:n; exitStatus:2,url:n,seed:null')).status).toBe(0);
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
