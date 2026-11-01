import { writeFileSync } from 'node:fs';

/** Public Playwright Reporter API only. Built-in JSON merges project-dependent spec ids; this companion never merges cases. */
export default class BrowserCaseReporter {
  errors = [];
  tests = [];
  onBegin(config, suite) {
    this.config = { workers: config.workers, projects: config.projects.map(p => ({ id: p.name, repeatEach: p.repeatEach, retries: p.retries })) };
    if (new Set(this.config.projects.map(p => p.id)).size !== this.config.projects.length) {
      this.errors.push({ message: 'ambiguous public project names in browser identity report' });
    }
    this.tests = suite.allTests();
  }
  onError(error) { this.errors.push(error); }
  printsToStdio() { return false; }
  onEnd(result) {
    const stats = { expected: 0, unexpected: 0, flaky: 0, skipped: 0 };
    const specs = this.tests.map(test => {
      const project = test.parent.project();
      if (!project || !this.config.projects.some(p => p.id === project.name)) this.errors.push({ message: 'missing public project identity' });
      const status = test.outcome(); stats[status]++;
      return { id: test.id, title: test.titlePath().join(' > '), tests: [{ projectId: project?.name, projectName: project?.name,
        expectedStatus: test.expectedStatus, annotations: test.annotations, repeatEachIndex: test.repeatEachIndex, retries: test.retries,
        status, results: test.results.map(r => ({ retry: r.retry, status: r.status, errors: r.errors, error: r.error })) }] };
    });
    // Errors are deliberately propagated through the report, never printed here. Full raw detail remains in built-in JSON.
    const output = process.env.CLOUDIATOR_BROWSER_IDENTITY_REPORT;
    if (!output) throw new Error('browser identity report output path missing');
    writeFileSync(output, JSON.stringify({ identityVersion: 1, config: this.config, suites: [{ title: 'browser cases', specs }], errors: this.errors, stats,
      runStatus: result.status }));
  }
}
