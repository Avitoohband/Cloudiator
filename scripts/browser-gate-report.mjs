/** Validate installed Playwright JSON without trusting aggregate counts or printing report/configuration contents. */
export function inspectBrowser(report, { inventory = false, bounded = false, companion = false, allowEmpty = false, marker = 'Probable host fault:' } = {}) {
  const cases = [], failures = [];
  let failed = 0;
  const invalid = message => failures.push({ test: '(report)', message });
  if (!report || !Array.isArray(report.suites) || !Array.isArray(report.errors)) {
    return { cases, failed, failures: [{ test: '(no report)', message: 'missing or malformed browser report' }], status: 'failed' };
  }
  if (!report.stats || ['expected', 'unexpected', 'flaky', 'skipped'].some(k => !Number.isSafeInteger(report.stats[k]) || report.stats[k] < 0)) invalid('malformed browser statistics');
  for (const error of report.errors) failures.push({ test: '(run)', message: firstLine(error?.message ?? error?.value ?? 'browser run error') });
  const projects = report.config?.projects;
  if (companion && (report.identityVersion !== 1 || !['passed', 'failed', 'timedout', 'interrupted'].includes(report.runStatus))) invalid('missing or malformed browser identity protocol/completion');
  if (report.runStatus !== undefined && !['passed', 'failed'].includes(report.runStatus)) invalid('browser run was interrupted or timed out');
  if (report.runStatus === 'failed') invalid('browser run reported failure');
  if (bounded && (!Array.isArray(projects) || !projects.length || report.config.workers !== 1
    || projects.some(p => typeof p?.id !== 'string' || p.repeatEach !== 1 || p.retries !== 0)
    || new Set(projects.map(p => p.id)).size !== projects.length)) invalid('bounded browser configuration must report one worker, no retries and no repeats');
  const seen = new Set();
  const walk = (suite, path) => {
    if (!suite || !Array.isArray(suite.specs) || (suite.suites !== undefined && !Array.isArray(suite.suites))) { invalid('malformed browser suite'); return; }
    for (const spec of suite.specs) {
      if (!spec || typeof spec.id !== 'string' || !spec.id || !Array.isArray(spec.tests) || !spec.tests.length) { invalid('malformed browser spec identity'); continue; }
      for (const test of spec.tests) {
        if (!test || typeof test.projectId !== 'string' || !Array.isArray(test.results) || !Array.isArray(test.annotations)
          || !['passed', 'failed', 'skipped'].includes(test.expectedStatus)
          || !['expected', 'skipped', 'unexpected', 'flaky'].includes(test.status)) { invalid('malformed browser case'); continue; }
        const identity = [spec.id, test.projectId], key = JSON.stringify(identity);
        if (seen.has(key)) invalid(`duplicate browser case identity: ${key}`);
        seen.add(key);
        if (bounded && Array.isArray(projects) && !projects.some(p => p.id === test.projectId)) invalid(`unknown browser project identity: ${key}`);
        cases.push({ identity, skipped: !inventory && test.status === 'skipped' });
        if (companion && (test.repeatEachIndex !== 0 || test.retries !== 0)) invalid('identity case must report no repeats or retries');
        if (bounded && ((test.repeatEachIndex !== undefined && test.repeatEachIndex !== 0) || (test.retries !== undefined && test.retries !== 0))) invalid('browser case configured with repeats or retries');
        if (inventory) {
          if (test.results.length || test.status !== 'skipped') invalid('inventory contains execution results or an invalid discovery outcome');
          continue;
        }
        const results = test.results;
        const skipped = test.status === 'skipped' && (test.expectedStatus === 'skipped' || test.annotations.some(a => ['skip', 'fixme'].includes(a?.type)));
        const legitimateSkip = skipped && results.length <= 1 && results.every(r => r?.retry === 0 && r.status === 'skipped' && Array.isArray(r.errors) && !r.errors.length && !r.error);
        const expected = test.status === 'expected' && ['passed', 'failed'].includes(test.expectedStatus) && results.length === 1
          && results[0]?.retry === 0 && results[0].status === test.expectedStatus && Array.isArray(results[0].errors)
          && (test.expectedStatus === 'failed' || (!results[0].errors.length && !results[0].error));
        const messages = results.flatMap(r => [...(Array.isArray(r?.errors) ? r.errors : []), ...(r?.error ? [r.error] : [])])
          .map(e => String(e?.message ?? e?.value ?? ''));
        const fault = messages.find(m => m.includes(marker));
        if ((legitimateSkip || expected) && !fault) continue;
        failed++;
        const own = messages.find(m => !m.includes(marker));
        failures.push({ test: `[${test.projectName ?? test.projectId}] ${[...path, spec.title].join(' > ')}`,
          message: firstLine(own ?? 'invalid browser outcome, retry, repeat or missing result'),
          ...(fault ? { hostFault: firstLine(fault.slice(fault.indexOf(marker) + marker.length)) } : {}) });
      }
    }
    for (const child of suite.suites ?? []) walk(child, [...path, child?.title ?? '']);
  };
  for (const suite of report.suites) walk(suite, [suite?.title ?? '']);
  if (!failures.length && (report.stats?.unexpected || report.stats?.flaky)) invalid('browser statistics report unexpected or flaky cases');
  if (!allowEmpty && !cases.length) invalid('browser report contains no actual cases');
  return { cases, failed, failures, status: failures.length ? 'failed' : 'passed' };
}
const firstLine = text => String(text).split('\n')[0].trim();
