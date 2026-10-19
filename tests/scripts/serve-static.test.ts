import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { contentSecurityPolicy, headersFile } from '../../scripts/build-headers.mjs';

// Task 23.6 (plan Decision 7): the local export host applies the export's own `_headers`, as Cloudflare Pages does, so the
// production browser gate runs under the deployed policy and fails on any violation. It never serves `_headers` itself,
// and it refuses an export that has none.

const directories: string[] = [];
const servers: ChildProcess[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.kill();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function exportedSite(headers: string | null = headersFile(null)) {
  const directory = mkdtempSync(join(tmpdir(), 'cloudiator-serve-'));
  directories.push(directory);
  mkdirSync(join(directory, 'game'), { recursive: true });
  mkdirSync(join(directory, '_next/static/chunks'), { recursive: true });
  writeFileSync(join(directory, 'index.html'), '<main>Cloudiator</main>');
  writeFileSync(join(directory, 'game/index.html'), '<main>Camp</main>');
  writeFileSync(join(directory, '_next/static/chunks/app.js'), 'console.log(1)');
  if (headers !== null) writeFileSync(join(directory, '_headers'), headers);
  return directory;
}
const freePort = () => new Promise<number>((done, fail) => {
  const probe = createServer().once('error', fail).listen(0, '127.0.0.1', () => {
    const { port } = probe.address() as { port: number };
    probe.close(() => done(port));
  });
});
async function serve(root: string) {
  const port = await freePort();
  const server = spawn(process.execPath, [resolve('scripts/serve-static.mjs')], {
    env: { ...process.env, CLOUDIATOR_STATIC_ROOT: root, CLOUDIATOR_STATIC_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  servers.push(server);
  await new Promise<void>((ready, fail) => {
    server.stdout!.on('data', (chunk: Buffer) => { if (chunk.toString().includes(`127.0.0.1:${port}`)) ready(); });
    server.once('exit', code => fail(new Error(`server exited ${code}`)));
  });
  return `http://127.0.0.1:${port}`;
}

describe('scripts/serve-static.mjs', () => {
  it('sends the export\'s security headers on every route and immutable caching on /_next/static/*', async () => {
    const origin = await serve(exportedSite());
    for (const path of ['/', '/game/', '/_next/static/chunks/app.js']) {
      const response = await fetch(`${origin}${path}`);
      expect(response.status, path).toBe(200);
      expect(response.headers.get('content-security-policy'), path).toBe(contentSecurityPolicy(null));
      expect(response.headers.get('x-content-type-options'), path).toBe('nosniff');
      expect(response.headers.get('referrer-policy'), path).toBe('strict-origin-when-cross-origin');
      expect(response.headers.get('permissions-policy'), path).toBe('camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    }
    expect((await fetch(`${origin}/_next/static/chunks/app.js`)).headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect((await fetch(`${origin}/game/`)).headers.get('cache-control')).toBeNull();
    // A missing page still carries the policy.
    const missing = await fetch(`${origin}/nowhere/`);
    expect(missing.status).toBe(404);
    expect(missing.headers.get('content-security-policy')).toBe(contentSecurityPolicy(null));
  });

  it('never serves _headers itself', async () => {
    const origin = await serve(exportedSite());
    expect((await fetch(`${origin}/_headers`)).status).toBe(404);
  });

  it('refuses to serve an export without _headers', () => {
    const result = spawnSync(process.execPath, [resolve('scripts/serve-static.mjs')], { encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, CLOUDIATOR_STATIC_ROOT: exportedSite(null), CLOUDIATOR_STATIC_PORT: '0' } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('_headers');
  });
});
