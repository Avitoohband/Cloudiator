import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { gateReport, gateSteps, parseOptions, runGate, summarize } from '../../scripts/verify.mjs';

type Step = ReturnType<typeof gateSteps>[number];
// Literal case identities deliberately share a spec across two projects: title/count comparisons cannot prove coverage.
const identities = [['spec-a', 'desktop'], ['spec-a', 'mobile'], ['spec-b', 'desktop']] as const;
function report(ids: readonly (readonly string[])[] = identities, inventory = false): any {
  return { identityVersion: 1, runStatus: 'passed', config: { workers: 1, projects: ['desktop', 'mobile'].map(id => ({ id, repeatEach: 1, retries: 0 })) },
    errors: [], stats: { expected: ids.length, unexpected: 0, flaky: 0, skipped: 0 },
    suites: [{ title: 'cases.spec.ts', specs: ids.map(([id, projectId]) => ({ id, title: id, tests: [{ projectId,
      projectName: projectId, expectedStatus: 'passed', annotations: [], repeatEachIndex: 0, retries: 0, status: inventory ? 'skipped' : 'expected',
      results: inventory ? [] : [{ retry: 0, status: 'passed', errors: [] }] }] })) }] };
}
function rig(reports: any[], codes: number[] = [], phase = 'browser') {
  const seen: Step[] = [];
  const written = new Map<string, any>();
  let active = 0, peak = 0;
  return { seen, peak: () => peak, io: {
    exec: async (step: Step) => { seen.push(step); const next = reports.shift();
      const pair = next && Object.hasOwn(next, 'raw');
      written.set(step.report!, pair ? next.raw : next); if (step.identityReport) written.set(step.identityReport, pair ? next.identity : next);
      active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 1)); active--; return codes.shift() ?? 0; },
    readBrowserReport: (step: Step) => written.get(step.report!), log: () => undefined,
  }, steps: gateSteps({ browserShards: 2, results: 'scratch-results', config: 'private.mjs' }).filter(s => s.id === phase) };
}
const good = () => [report(identities, true), report([identities[0], identities[2]]), report([identities[1]])];
const run = async (reports: any[], codes?: number[]) => { const r = rig(reports, codes); return { r, result: (await runGate(r.steps, r.io))[0] as any }; };

describe('bounded browser phase orchestration', () => {
  it('discovers the full manifest then awaits each one-worker zero-retry shard, with separate durable reports and outputs', async () => {
    const { r, result } = await run(good());
    expect(result.status).toBe('passed');
    expect(r.seen).toHaveLength(3);
    expect(r.peak()).toBe(1);
    expect(r.seen.map(s => s.args?.find(a => a.startsWith('--shard=')))).toEqual([undefined, '--shard=1/2', '--shard=2/2']);
    expect(r.seen[0].args).toContain('--list');
    for (const step of r.seen) {
      expect(step.args).toEqual(expect.arrayContaining(['--config', 'private.mjs', '--workers=1', '--retries=0', '--repeat-each=1']));
      expect(step.report?.replace(/\\/g, '/')).toMatch(/^scratch-results\/development\/(inventory|shard-[12]-of-2)\/report.json$/);
      expect(step.env?.PLAYWRIGHT_JSON_OUTPUT_NAME).toBe(resolve(step.report!));
      expect(step.env?.PLAYWRIGHT_JSON_OUTPUT_FILE).toBe(resolve(step.report!));
    }
    expect(new Set(r.seen.map(s => s.report)).size).toBe(3);
    const outputs = r.seen.map(s => s.args![s.args!.indexOf('--output') + 1].replace(/\\/g, '/'));
    expect(outputs).toEqual(['scratch-results/development/inventory/results', 'scratch-results/development/shard-1-of-2/results', 'scratch-results/development/shard-2-of-2/results']);
    const json = JSON.parse(JSON.stringify(gateReport([result], summarize([result]), 'start', 'end')));
    expect(json.results[0].browser.coverage).toMatchObject({ complete: true, expected: 3, observed: 3, executable: 3, skipped: 0,
      missing: [], extra: [], duplicates: [], identities: [['spec-a', 'desktop'], ['spec-a', 'mobile'], ['spec-b', 'desktop']] });
    expect(json.results[0].browser.shards.map((s: any) => s.report)).toEqual(r.seen.slice(1).map(s => s.report));
    expect(json.results[0].browser.inventory.report).toBe(r.seen[0].report);
  });

  it.each(['missing', 'extra', 'duplicate', 'project substitution'])('fails exact coverage with %s identity despite plausible counts', async fault => {
    const reports = good();
    if (fault === 'missing') reports[2] = report([]);
    if (fault === 'extra') reports[2] = report([identities[1], ['extra', 'mobile']]);
    if (fault === 'duplicate') reports[2] = report([identities[0]]);
    if (fault === 'project substitution') reports[2] = report([['spec-a', 'unknown']]);
    const { result } = await run(reports);
    expect(result.status).toBe('failed');
    expect(result.browser.coverage.complete).toBe(false);
  });

  it.each(['missing', 'malformed', 'run error', 'duplicate', 'empty', 'repeat', 'retry config', 'unexpected outcome', 'flaky outcome', 'failed completion'])('fails closed on %s inventory without executing shards', async fault => {
    let inventory = report(identities, true);
    if (fault === 'missing') inventory = null;
    if (fault === 'malformed') inventory.suites[0].specs[0].tests = null;
    if (fault === 'run error') inventory.errors = [{ message: 'discovery failed' }];
    if (fault === 'duplicate') inventory.suites[0].specs.push(inventory.suites[0].specs[0]);
    if (fault === 'empty') inventory = report([], true);
    if (fault === 'repeat') inventory.config.projects[0].repeatEach = 2;
    if (fault === 'retry config') inventory.config.projects[0].retries = 1;
    if (fault === 'unexpected outcome') inventory.suites[0].specs[0].tests[0].status = 'unexpected';
    if (fault === 'flaky outcome') inventory.suites[0].specs[0].tests[0].status = 'flaky';
    if (fault === 'failed completion') inventory.runStatus = 'failed';
    const { r, result } = await run([inventory]);
    expect(result.status).toBe('failed');
    expect(r.seen).toHaveLength(1);
  });

  it.each(['missing', 'malformed', 'run error', 'flaky', 'interrupted', 'unexpected', 'no result', 'retry', 'repeat', 'skip without evidence', 'passed with errors'])('fails closed on %s shard report without rerunning it', async fault => {
    const reports = good(); const test = reports[1].suites[0].specs[0].tests[0];
    if (fault === 'missing') reports[1] = null;
    if (fault === 'malformed') delete test.projectId;
    if (fault === 'run error') reports[1].errors = [{ message: 'runner failed' }];
    if (['flaky', 'unexpected'].includes(fault)) test.status = fault;
    if (fault === 'interrupted') test.results[0].status = 'interrupted';
    if (fault === 'no result') test.results = [];
    if (fault === 'retry') test.results[0].retry = 1;
    if (fault === 'repeat') test.results.push({ ...test.results[0] });
    if (fault === 'skip without evidence') { test.status = 'skipped'; test.results = []; }
    if (fault === 'passed with errors') test.results[0].errors = [{ message: 'late error' }];
    const { r, result } = await run(reports);
    expect(result.status).toBe('failed');
    expect(r.seen.filter(s => s.args?.includes('--shard=1/2'))).toHaveLength(1);
  });

  it.each(['missing raw', 'missing identity', 'raw failure', 'no protocol', 'no completion', 'case count mismatch', 'case repeat', 'case retry'])('requires both independent raw and identity evidence: %s', async fault => {
    const reports = good(); const raw = report([identities[0], identities[2]]), identity = structuredClone(raw);
    if (fault === 'raw failure') raw.errors.push({ message: 'raw run error' });
    if (fault === 'no protocol') delete identity.identityVersion;
    if (fault === 'no completion') delete identity.runStatus;
    if (fault === 'case count mismatch') raw.suites[0].specs.pop();
    if (fault === 'case repeat') identity.suites[0].specs[0].tests[0].repeatEachIndex = 1;
    if (fault === 'case retry') identity.suites[0].specs[0].tests[0].retries = 1;
    reports[1] = { raw: fault === 'missing raw' ? null : raw, identity: fault === 'missing identity' ? null : identity };
    expect((await run(reports)).result.status).toBe('failed');
  });

  it('preserves expected failures and explicit static and runtime skips', async () => {
    const reports = good();
    const expectedFailure = reports[1].suites[0].specs[0].tests[0];
    expectedFailure.expectedStatus = 'failed'; expectedFailure.results[0] = { retry: 0, status: 'failed', errors: [{ message: 'intentional' }] };
    const staticSkip = reports[1].suites[0].specs[1].tests[0];
    staticSkip.expectedStatus = 'skipped'; staticSkip.status = 'skipped'; staticSkip.results = [];
    const runtimeSkip = reports[2].suites[0].specs[0].tests[0];
    runtimeSkip.expectedStatus = 'skipped'; runtimeSkip.status = 'skipped'; runtimeSkip.results[0].status = 'skipped';
    const { result } = await run(reports);
    expect(result.status).toBe('passed');
    expect(result.browser.coverage).toMatchObject({ complete: true, executable: 1, skipped: 2 });
  });

  it('does not treat a host fault as an expected-failure control', async () => {
    const reports = good(); const test = reports[1].suites[0].specs[0].tests[0];
    test.expectedStatus = 'failed'; test.results[0].status = 'failed';
    test.results[0].errors = [{ message: 'Probable host fault: net::ERR_NO_BUFFER_SPACE' }];
    const { result } = await run(reports);
    expect(result.status).toBe('failed');
    expect(result.browser.failures).toContainEqual(expect.objectContaining({ hostFault: 'net::ERR_NO_BUFFER_SPACE' }));
  });

  it.each([0, 1, 2])('fails a nonzero child exit at position %i without repeating any process', async index => {
    const codes = [0, 0, 0]; codes[index] = 1;
    const { r, result } = await run(good(), codes);
    expect(result.status).toBe('failed');
    expect(r.seen.length).toBe(index === 0 ? 1 : 3);
  });

  it('retains host-fault labels and phase environment in production shards', async () => {
    const reports = good(); const test = reports[1].suites[0].specs[0].tests[0];
    test.status = 'unexpected'; test.results[0].status = 'failed';
    test.results[0].errors = [{ message: 'own assertion' }, { message: 'Probable host fault: net::ERR_NO_BUFFER_SPACE' }];
    const r = rig(reports, [0, 1, 0], 'production');
    // Isolated phase harness has no build dependency; the full gate retains that dependency.
    r.steps[0] = { ...r.steps[0], needs: [] };
    const result = (await runGate(r.steps, r.io))[0] as any;
    expect(result.status).toBe('failed');
    expect(result.browser.failures).toContainEqual(expect.objectContaining({ message: 'own assertion', hostFault: 'net::ERR_NO_BUFFER_SPACE' }));
    for (const s of r.seen) expect(s.env).toMatchObject({ PLAYWRIGHT_STATIC: 'true', PLAYWRIGHT_STATIC_ROOT: '.next/browser-test' });
  });
});

describe('ordinary browser report evidence and shard option', () => {
  it.each([null, { suites: [], stats: { expected: 999 } }, { suites: 'bad' }, report([['a', 'desktop']])])('requires a valid positive-case report after exit zero (%j)', async bad => {
    if (bad?.suites && Array.isArray(bad.suites) && bad.suites.length) bad.suites[0].specs[0].tests[0].status = 'unexpected';
    const r = rig([bad]); r.steps = gateSteps().filter(s => s.id === 'browser');
    const result = (await runGate(r.steps, r.io))[0];
    expect(result.status).toBe('failed'); expect(r.seen).toHaveLength(1);
  });
  it('keeps ordinary success a single process and defaults to one shard', async () => {
    const r = rig([report()]); r.steps = gateSteps().filter(s => s.id === 'browser');
    expect((await runGate(r.steps, r.io))[0].status).toBe('passed'); expect(r.seen).toHaveLength(1);
    expect(r.seen[0].args?.some(a => a.startsWith('--shard'))).toBe(false);
    expect(parseOptions([]).browserShards).toBe(1);
    expect(parseOptions(['--browser-shards', '4']).browserShards).toBe(4);
  });
  it('records an unreadable ordinary report as failure while subsequent gate steps still run', async () => {
    const r = rig([]);
    const io = { ...r.io, readBrowserReport: () => { throw new Error('unreadable'); } };
    const steps = gateSteps().filter(s => ['browser', 'diff'].includes(s.id));
    const results = await runGate(steps, io);
    expect(results.map(s => s.status)).toEqual(['failed', 'passed']);
    expect(r.seen.map(s => s.id)).toEqual(['browser', 'diff']);
  });
  it.each(['0', '-1', '1.5', 'Infinity', '33', 'abc', ''])('refuses unsafe shard count %s before running', value => {
    expect(() => parseOptions(['--browser-shards', value])).toThrow();
  });
});
