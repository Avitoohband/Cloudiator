import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

// Task 23.6 (R4, Avi decision 3): `.github/workflows/checks.yml` runs the release gate on a GitHub-hosted runner: a fresh local
// Supabase stack (every migration replayed), the local Edge functions, then `npm run verify`. It is checked here without
// running it: every command it calls exists, and it prints no local credentials. (No YAML parser is installed; the
// controller's push records the first run.)

const WORKFLOW = '.github/workflows/checks.yml';
const text = existsSync(WORKFLOW) ? readFileSync(WORKFLOW, 'utf8') : '';
const scripts = Object.keys(JSON.parse(readFileSync('package.json', 'utf8')).scripts as Record<string, string>);
/** The shell lines of the workflow's `run:` steps (single-line and block). */
function runLines(): string[] {
  const lines = text.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(?:- )?run: ?(.*)$/.exec(lines[i]);
    if (!m) continue;
    if (m[2] && m[2] !== '|' && m[2] !== '>') { out.push(m[2].trim()); continue; }
    const indent = m[1].length;
    for (i++; i < lines.length && (lines[i].trim() === '' || lines[i].search(/\S/) > indent); i++) if (lines[i].trim()) out.push(lines[i].trim());
    i--;
  }
  return out;
}

describe('the checks workflow', () => {
  it('exists, runs on pushes and pull requests, and reads the repository only', () => {
    expect(text).not.toBe('');
    expect(text).toMatch(/^on:\n {2}push:/m);
    expect(text).toMatch(/^ {2}pull_request:/m);
    expect(text).toMatch(/^permissions:\n {2}contents: read$/m);
    expect(text).not.toMatch(/\t/);
  });

  it('starts a fresh local stack and the Edge functions, then runs the release gate', () => {
    const run = runLines().join('\n');
    expect(run).toMatch(/npx supabase start --exclude studio,realtime,storage-api,imgproxy,mailpit,logflare,vector,supavisor/);
    expect(run).toMatch(/npx supabase functions serve --env-file \.env\.edge\.local/);
    expect(run).toMatch(/^npm ci$/m);
    expect(run).toMatch(/^npm run verify\b/m);
    // The order: the stack, the Edge functions, then the gate.
    expect(run.indexOf('supabase start')).toBeLessThan(run.indexOf('functions serve'));
    expect(run.indexOf('functions serve')).toBeLessThan(run.indexOf('npm run verify'));
  });

  it('calls only scripts and files that exist', () => {
    const run = runLines();
    for (const line of run) {
      for (const [, script] of line.matchAll(/npm run ([\w:-]+)/g)) expect(scripts, line).toContain(script);
      for (const [, file] of line.matchAll(/\bnode ((?:scripts|assets)\/[\w./-]+\.m?js)/g)) expect(existsSync(file), line).toBe(true);
    }
  });

  it('never prints local credentials', () => {
    const run = runLines().join('\n');
    expect(run).not.toMatch(/supabase status/);
    expect(run).not.toMatch(/cat \.env|type \.env|echo .*SECRET/i);
    // The start output contains the local keys: it goes to a file in the runner's temp folder, never to the log.
    expect(run).toMatch(/npx supabase start [^\n]*> "\$RUNNER_TEMP\/supabase-start\.log" 2>&1/);
    // Third-party actions are pinned to a release, never to a moving branch.
    for (const [, ref] of text.matchAll(/uses: [\w./-]+@(\S+)/g)) expect(ref).toMatch(/^v\d+(\.\d+){0,2}$|^[0-9a-f]{40}$/);
  });
});
