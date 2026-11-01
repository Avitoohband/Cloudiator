import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, get } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

const entrypoints = ['supabase/functions/game-command/index.ts', 'supabase/functions/game-worker/index.ts', 'tests/backend/edge.deno.ts'];
const script = JSON.parse(readFileSync('package.json', 'utf8')).scripts.typecheck as string;
const commands = script.split(' && ').map(command => command.split(/\s+/));
const deno = realpathSync(resolve('node_modules/deno', process.platform === 'win32' ? 'deno.exe' : 'deno'));

// Removing either offline flag must fail before launching Deno. Boundary cases below exercise the installed CLI's
// actual miss behavior; they never invoke the unrestricted command or use the developer's cache/registry settings.
describe('Deno verification policy', () => {
  it.each([1, 2])('requires cache-only frozen verification at stage %i', index => {
    const args = commands[index];
    expect(args).toContain('--cached-only');
    expect(args).toContain('--frozen');
    expect(args.slice(args.indexOf('--config'), args.indexOf('--config') + 2)).toEqual(['--config', 'supabase/functions/deno.json']);
    expect(args.filter(arg => arg.endsWith('.ts'))).toEqual(index === 1 ? entrypoints.slice(0, 2) : entrypoints.slice(2));
    expect(args.includes('--no-run')).toBe(index === 1);
    expect(args.includes('--check')).toBe(index === 1);
    expect(commands.map(tokens => tokens.slice(0, 2))).toEqual([['tsc', '--noEmit'], ['deno', 'test'], ['deno', 'test']]);
  });

  it('prepares the same locked imports explicitly in CI before the local runtime', () => {
    const ci = readFileSync('.github/workflows/checks.yml', 'utf8');
    const preparation = /^      - name: Prepare the locked Deno imports \(explicit dependency installation\)\r?\n        run: (.+)$/m.exec(ci);
    expect(preparation, 'cold CI must prepare imports separately from offline verification').not.toBeNull();
    const args = preparation![1].split(/\s+/);
    expect(args).toEqual(['npx', '--no-install', 'deno', 'cache', '--frozen', '--config', 'supabase/functions/deno.json', ...entrypoints]);
    expect(ci.indexOf('run: npm ci')).toBeLessThan(preparation!.index);
    expect(preparation!.index).toBeLessThan(ci.indexOf('- name: Start a fresh local Supabase stack'));
    expect(preparation!.index).toBeLessThan(ci.indexOf('- name: Serve the local Edge functions'));
  });
});

function cleanup(root: string, parent: string) {
  const target = realpathSync(root);
  if (dirname(target) !== parent || !basename(target).startsWith('cloudiator-deno-offline-')) throw new Error('fixture cleanup escaped its temporary parent');
  rmSync(target, { recursive: true, force: true });
}

async function fixture() {
  const parent = realpathSync(tmpdir()), root = mkdtempSync(join(parent, 'cloudiator-deno-offline-'));
  const requests: string[] = [];
  let healthRequests = 0;
  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/health') { healthRequests++; response.end('ready'); return; }
    requests.push(`${request.method} ${request.url}`);
    if (request.method === 'GET' && request.url === '/fixture.ts') {
      response.setHeader('Content-Type', 'application/typescript'); response.end('export const value = 1;');
    } else if (request.method === 'GET' && request.url === '/cloudiator-offline-fixture') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ name: 'cloudiator-offline-fixture', 'dist-tags': { latest: '1.0.0' }, versions: {
        '1.0.0': { name: 'cloudiator-offline-fixture', version: '1.0.0', dist: { tarball: `http://127.0.0.1:${(server.address() as { port: number }).port}/fixture.tgz` } },
      } }));
    } else { response.writeHead(404); response.end('unexpected fixture request'); }
  });
  try {
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await new Promise<void>((done, reject) => {
      get(`${origin}/health`, response => { response.resume(); response.on('end', done); }).on('error', reject);
    });
    expect(healthRequests).toBe(1); // Confirm the loopback observer is live, without requesting a dependency.
    return { root, origin, requests, async close() { await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); cleanup(root, parent); } };
  } catch (error) { server.close(); cleanup(root, parent); throw error; }
}

function runDeno(command: string, flags: string[], root: string, origin: string) {
  const cache = join(root, 'cold-cache'); mkdirSync(cache);
  writeFileSync(join(root, 'deno.json'), JSON.stringify({ nodeModulesDir: 'none', lock: './deno.lock' }));
  writeFileSync(join(root, 'deno.lock'), JSON.stringify({ version: '5',
    remote: { [`${origin}/fixture.ts`]: createHash('sha256').update('export const value = 1;').digest('hex') },
    specifiers: { 'npm:cloudiator-offline-fixture@1.0.0': '1.0.0' },
    npm: { 'cloudiator-offline-fixture@1.0.0': { integrity: `sha512-${createHash('sha512').update('synthetic fixture').digest('base64')}` } },
  }));
  // Allowlist system launch variables: no inherited proxies, Deno flags, auth, registry config or update checks.
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'test' };
  for (const name of ['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP']) {
    const actual = Object.keys(process.env).find(key => key.toUpperCase() === name.toUpperCase());
    if (actual) env[actual] = process.env[actual];
  }
  Object.assign(env, { DENO_DIR: cache, DENO_NO_UPDATE_CHECK: '1', DENO_NO_PROMPT: '1', NO_COLOR: '1',
    HOME: root, USERPROFILE: root, NPM_CONFIG_REGISTRY: `${origin}/`, NPM_CONFIG_USERCONFIG: join(root, '.npmrc') });
  writeFileSync(join(root, '.npmrc'), `registry=${origin}/\n`);
  return new Promise<{ code: number | null; signal: string | null; output: string }>((done, reject) => {
    const child = spawn(deno, [command, ...flags, '--config', join(root, 'deno.json'),
      `--allow-import=${new URL(origin).host}`, join(root, 'entry.ts')], { cwd: root, env, windowsHide: true, timeout: 15_000 });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
    child.on('error', reject); child.on('close', (code, signal) => done({ code, signal, output }));
  });
}

describe('installed Deno cold-cache boundaries', { timeout: 20_000 }, () => {
  for (const [index, stage] of [[1, 'function typecheck'], [2, 'edge tests']] as const) {
    // The flag comes from the verification command; the assertion prevents a policy regression from doing I/O even in RED.
    const flags = commands[index].filter(arg => ['--cached-only', '--frozen', '--no-run', '--check'].includes(arg));
    const expectedFlags = index === 1 ? ['--cached-only', '--frozen', '--no-run', '--check'] : ['--cached-only', '--frozen'];
    it.each(['module', 'npm'])(`${stage} refuses an uncached %s dependency without any fixture request`, async kind => {
      expect(flags).toEqual(expectedFlags);
      const f = await fixture();
      try {
        const dependency = kind === 'module' ? `${f.origin}/fixture.ts` : 'npm:cloudiator-offline-fixture@1.0.0';
        writeFileSync(join(f.root, 'entry.ts'), `import ${JSON.stringify(dependency)};\n`);
        const result = await runDeno('test', flags, f.root, f.origin);
        expect(f.requests).toEqual([]);
        expect(result.signal).toBeNull(); expect(result.code, result.output).toBe(1);
        expect(result.output).toMatch(kind === 'module' ? /not found in cache|not cached/i : /npm package.*not found|not found.*cache|not cached/i);
        expect(result.output).toContain(kind === 'module' ? '/fixture.ts' : 'cloudiator-offline-fixture');
        expect(result.output).not.toMatch(/\bDownload\b/);
        expect(f.requests).toEqual([]);
      } finally { await f.close(); }
    });

    it(`${stage} accepts local code with the same isolated cache-only invocation`, async () => {
      expect(flags).toEqual(expectedFlags);
      const f = await fixture();
      try {
        writeFileSync(join(f.root, 'entry.ts'), "Deno.test('local control', () => { if (1 + 1 !== 2) throw new Error('arithmetic'); });\n");
        const result = await runDeno('test', flags, f.root, f.origin);
        expect(result.signal).toBeNull(); expect(result.code, result.output).toBe(0);
        if (index === 2) expect(result.output).toMatch(/1 passed \| 0 failed/);
        expect(result.output).not.toMatch(/\bDownload\b/); expect(f.requests).toEqual([]);
      } finally { await f.close(); }
    });
  }
});

describe('function typecheck execution boundaries', { timeout: 20_000 }, () => {
  const flags = commands[1].filter(arg => ['--cached-only', '--frozen', '--no-run', '--check'].includes(arg));
  it('does not execute a local entrypoint with a top-level throw', async () => {
    const f = await fixture();
    try {
      writeFileSync(join(f.root, 'entry.ts'), "throw new Error('MUST NOT EXECUTE');\n");
      const result = await runDeno('test', flags, f.root, f.origin);
      expect(result.signal).toBeNull(); expect(result.code, result.output).toBe(0);
      expect(result.output).not.toContain('MUST NOT EXECUTE');
      expect(result.output).toContain('Check entry.ts'); expect(f.requests).toEqual([]);
    } finally { await f.close(); }
  });
  it('still rejects a deliberate type error in a local entrypoint without tests', async () => {
    const f = await fixture();
    try {
      writeFileSync(join(f.root, 'entry.ts'), 'const value: number = "wrong";\nexport { value };\n');
      const result = await runDeno('test', flags, f.root, f.origin);
      expect(result.signal).toBeNull(); expect(result.code, result.output).toBe(1);
      expect(result.output).toContain('TS2322'); expect(f.requests).toEqual([]);
    } finally { await f.close(); }
  });
});
