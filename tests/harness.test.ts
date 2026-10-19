import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Task 23.6. (1) The production gate fails on any Content-Security-Policy violation: every browser spec takes `test` from
// tests/browser/fixtures.ts, whose automatic fixture listens for violations, so a new spec cannot bypass the listener.
// (2) Gate output is pristine (C23): the suites the gate runs print nothing of their own. A measurement a suite records is
// printed only behind the explicit CLOUDIATOR_MEASUREMENTS=1 switch (tests/fixtures/measurements.ts).

const files = (directory: string, pattern: RegExp): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? files(join(directory, entry.name), pattern) : pattern.test(entry.name) ? [join(directory, entry.name).replace(/\\/g, '/')] : []);

describe('the CSP listener', () => {
  it('is the test of every browser spec', () => {
    const specs = files('tests/browser', /\.spec\.ts$/);
    expect(specs.length).toBeGreaterThan(20);
    const bypassing = specs.filter(spec => /from '@playwright\/test'/.test(readFileSync(spec, 'utf8')));
    expect(bypassing).toEqual([]);
    const listening = specs.filter(spec => /import \{[^}]*\btest\b[^}]*\} from '\.\/fixtures'/.test(readFileSync(spec, 'utf8')));
    expect(listening).toEqual(specs);
  });
});

describe('gate output', () => {
  it('has no console output of the suites themselves', () => {
    const suites = [...files('tests/db', /\.ts$/), ...files('tests/browser', /\.ts$/), ...files('tests/fixtures', /\.ts$/), 'tests/performance/harness.ts']
      .filter(file => file !== 'tests/fixtures/measurements.ts');
    const printing = suites.flatMap(file => readFileSync(file, 'utf8').split('\n').map((line, at) => [file, at + 1, line] as const)
      .filter(([, , line]) => /\bconsole\.(log|info|debug|warn|error|table|dir|trace)\s*\(/.test(line)).map(([file, line]) => `${file}:${line}`));
    expect(printing).toEqual([]);
  });
});

describe('host network faults (C21 triage)', () => {
  it('names only the errors of the host\'s network stack, never a request a test aborts or a server refuses', async () => {
    const { isHostFault } = await import('./browser/host-faults.ts');
    for (const text of ['net::ERR_NO_BUFFER_SPACE', 'net::ERR_INSUFFICIENT_RESOURCES', 'net::ERR_ADDRESS_IN_USE']) expect(isHostFault(text), text).toBe(true);
    // route.abort() and refused or reset connections are product-visible failures a test may cause or expect.
    for (const text of ['net::ERR_FAILED', 'net::ERR_ABORTED', 'net::ERR_CONNECTION_REFUSED', 'net::ERR_CONNECTION_RESET', 'net::ERR_NAME_NOT_RESOLVED',
      'net::ERR_BLOCKED_BY_CLIENT', '', undefined, null]) expect(isHostFault(text), String(text)).toBe(false);
  });

  it('are named on a failed test by the browser fixture', () => {
    const fixture = readFileSync('tests/browser/fixtures.ts', 'utf8');
    expect(fixture).toMatch(/import \{[^}]*\bisHostFault\b[^}]*\} from '\.\/host-faults'/);
    expect(fixture).toContain("on('requestfailed'");
    expect(fixture).toContain('HOST_FAULT_MARKER');
  });
});
