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

  // Task 24.0d, the controller's CI exception (2026-10-21): the free runner is too slow for the development browser suite, so the
  // release gate step, and only it, sets CLOUDIATOR_CI=github, and scripts/verify.mjs then reports that step as `not run on CI`
  // (never silently). The comment says why, and that the local gate runs everything. Task 24.0c's CLOUDIATOR_CI_RENDER is gone.
  it('does not run the development browser suite in the release gate step only, and says why', () => {
    // The step's own lines: everything indented under `- name: Release gate`, up to the next step.
    const gate = /^ {6}- name: Release gate\n((?: {8}.*\n|\n)*)/m.exec(text)?.[1] ?? '';
    expect(gate).toMatch(/^ {8}env:\n {10}CLOUDIATOR_CI: github$/m);
    expect(gate).toMatch(/^ {8}run: \|\n {10}npm run verify\b/m);
    const comment = gate.split('\n').filter(line => /^ {8}#/.test(line)).map(line => line.replace(/^ {8}# ?/, '')).join(' ');
    for (const phrase of ["controller's CI exception", 'too slow', 'not run on CI', 'never silently', '39588134783', 'gate of record',
      'production gate']) expect(comment, phrase).toContain(phrase);
    // Set once, there: no other step, and not the whole job.
    expect(text.match(/CLOUDIATOR_CI:/g)).toHaveLength(1);
    expect(text).not.toContain('CLOUDIATOR_CI_RENDER');
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
    // Every action is pinned to a full commit SHA with its release as a comment (fix round 1), never to a moving tag.
    const uses = [...text.matchAll(/uses: ([\w./-]+)@(\S+)(.*)$/gm)];
    expect(uses.length).toBe(3);
    for (const [, action, ref, comment] of uses) {
      expect(ref, action).toMatch(/^[0-9a-f]{40}$/);
      expect(comment.trim(), action).toMatch(/^# v\d+\.\d+\.\d+$/);
    }
  });
});

/** One named step, without assuming whether its condition is true for this run. */
function namedStep(name: string): string {
  const lines = text.split('\n');
  const start = lines.indexOf(`      - name: ${name}`);
  if (start < 0) return '';
  let end = start + 1;
  while (end < lines.length && !/^ {6}- /.test(lines[end])) end++;
  return lines.slice(start + 1, end).join('\n');
}

/** Evaluate only the comparisons/boolean operators used by these actual workflow selectors; fail closed on new syntax. */
function selected(step: string, event: string, fullGate?: boolean): boolean {
  const expression = /^ {8}if: \$\{\{ (.+) \}\}$/m.exec(step)?.[1];
  if (!expression) throw new Error('Gate step must have an explicit selector');
  const values: Record<string, string | boolean | undefined> = {
    'github.event_name': event,
    'inputs.full_development_gate': fullGate,
  };
  // GitHub gives && higher precedence than ||, matching these two split levels.
  return expression.split(' || ').some(term => term.split(' && ').every(comparison => {
    const match = /^(github\.event_name|inputs\.full_development_gate) (==|!=) ('[^']*'|true|false)$/.exec(comparison);
    if (!match) throw new Error(`Unsupported workflow selector: ${comparison}`);
    const expected = match[3] === 'true' ? true : match[3] === 'false' ? false : match[3].slice(1, -1);
    return match[2] === '==' ? values[match[1]] === expected : values[match[1]] !== expected;
  }));
}

describe('the optional complete Linux gate', () => {
  const normal = namedStep('Release gate');
  const full = namedStep('Complete development release gate (manual opt-in)');

  it('requires a typed manual input that defaults to false', () => {
    expect(text).toMatch(/^ {2}workflow_dispatch:\n {4}inputs:\n {6}full_development_gate:\n {8}description: [^\n]+\n {8}type: boolean\n {8}required: false\n {8}default: false$/m);
    expect(normal).not.toBe('');
    expect(full).not.toBe('');
  });

  it.each([
    ['push', undefined, true, false],
    ['pull_request', undefined, true, false],
    ['workflow_dispatch', undefined, true, false],
    ['workflow_dispatch', false, true, false],
    ['workflow_dispatch', true, false, true],
    // An input-looking value on an automatic event must never select the opt-in branch.
    ['push', true, true, false],
    ['pull_request', true, true, false],
  ] as const)('selects exactly one gate for event %s / full=%s', (event, input, normalExpected, fullExpected) => {
    const actual = [selected(normal, event, input), selected(full, event, input)];
    expect(actual).toEqual([normalExpected, fullExpected]);
    expect(actual.filter(Boolean)).toHaveLength(1);
  });

  it('keeps the ordinary 11-step gate and its explicit development omission intact', () => {
    expect(normal).toMatch(/^ {8}env:\n {10}CLOUDIATOR_CI: github$/m);
    expect(normal).toMatch(/^ {8}run: \|\n {10}npm run verify -- --json "\$RUNNER_TEMP\/verify\.json"$/m);
    expect(normal).not.toContain('VITEST_MAX_WORKERS');
    expect(normal).not.toContain('--config');
    expect(normal).not.toContain('--browser-shards');
    expect(text.match(/CLOUDIATOR_CI:/g)).toHaveLength(1);
  });

  it('unsets the omission switch before the unchanged full controller, with strict process-scoped units', () => {
    expect(full).toMatch(/^ {8}env:\n {10}VITEST_MAX_WORKERS: '1'$/m);
    expect(full).toMatch(/^ {8}run: \|\n {10}unset CLOUDIATOR_CI\n {10}npm run verify -- --config playwright\.full-gate\.config\.ts --browser-shards 8 --results "\$RUNNER_TEMP\/full-gate-\$\{GITHUB_RUN_ID\}-\$\{GITHUB_RUN_ATTEMPT\}" --json "\$RUNNER_TEMP\/verify\.json"$/m);
    expect(full).not.toMatch(/^ {10}CLOUDIATOR_CI:/m);
    expect(full).not.toContain('continue-on-error');
    expect(full).not.toMatch(/--grep|--grep-invert|--last-failed|--update-snapshots/);
    expect(runLines().join('\n')).not.toMatch(/\bplaywright install\b/);
    expect(text).toMatch(/^ {4}timeout-minutes: 120$/m);
  });

  it('retains the full summary and entire unique browser evidence root, without credential logs or environment files', () => {
    const paths = /^ {10}path: \|\n((?: {12}.*\n|\n)*)/m.exec(text)?.[1]
      .split('\n').map(line => line.trim()).filter(Boolean);
    expect(paths).toEqual([
      '${{ runner.temp }}/verify.json',
      'test-results/',
      '${{ runner.temp }}/full-gate-${{ github.run_id }}-${{ github.run_attempt }}/',
    ]);
    expect(text).toMatch(/^ {6}- name: Keep the gate's results and the browser traces\n {8}if: \$\{\{ always\(\) \}\}$/m);
  });
});
