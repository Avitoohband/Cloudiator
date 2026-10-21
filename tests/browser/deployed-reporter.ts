import type { Reporter, TestCase, TestResult } from '@playwright/test/reporter';
import { evidenceLine } from './deployed-checks';

/**
 * The deployed checks' evidence (Task 24.2b): the list reporter shows no annotations, so this reporter, after the list
 * reporter's summary, prints every check's `evidence` annotation (tests/browser/deployed.spec.ts adds one per check before its
 * verdict, passing or failing) as one masked line, `deployed evidence | <project> | <check> | …`, in the order the checks
 * ended. It prints at the end only, so the list reporter's own lines stay intact. A line holds counts, statuses, codes,
 * origins and our own header values only. Used by tests/browser/playwright.deployed.config.ts.
 */
export default class DeployedEvidenceReporter implements Reporter {
  private readonly lines: string[] = [];

  onTestEnd(test: TestCase, result: TestResult) {
    const project = test.parent.project()?.name ?? 'unknown';
    for (const annotation of result.annotations) {
      if (annotation.type === 'evidence' && annotation.description) this.lines.push(evidenceLine(project, test.title, annotation.description));
    }
  }

  onEnd() {
    if (this.lines.length) process.stdout.write(`\nDeployed evidence (one line per check):\n${this.lines.join('\n')}\n`);
  }

  printsToStdio() {
    return true;
  }
}
