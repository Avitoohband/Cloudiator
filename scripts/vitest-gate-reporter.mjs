/**
 * A vitest reporter for the release gate (scripts/verify.mjs, Task 23.6 fix round 1). At the end of a run it writes to
 * CLOUDIATOR_GATE_REPORT every failure the run had, so the gate can tell a known blocker from anything else:
 * - each module's own errors (an import or a top-level hook that failed);
 * - each failed suite with its own errors (a describe-level hook), and with none when only a test inside it failed;
 * - each failed test with its suites and the first line of each error;
 * - the run's unhandled errors and its end reason.
 * Only names and first lines of messages are written: no values, environment or credentials.
 */
import { writeFileSync } from 'node:fs';

const firstLine = (error) => String(error?.message ?? error?.name ?? error ?? '').split('\n')[0].trim();
/** The full names of a task's enclosing suites, innermost last. */
function ancestors(task) {
  const names = [];
  for (let parent = task.parent; parent && parent.type === 'suite'; parent = parent.parent) names.unshift(parent.fullName);
  return names;
}

export default class GateReporter {
  onTestRunEnd(testModules, unhandledErrors, reason) {
    const file = process.env.CLOUDIATOR_GATE_REPORT;
    if (!file) return;
    const report = { reason, unhandledErrors: (unhandledErrors ?? []).map(firstLine), passed: 0, modules: [] };
    for (const module of testModules) {
      const entry = { file: String(module.relativeModuleId ?? module.moduleId).replace(/\\/g, '/'), state: module.state(),
        errors: module.errors().map(firstLine), suites: [], tests: [] };
      for (const suite of module.children.allSuites()) {
        if (suite.state() === 'failed' || suite.errors().length) entry.suites.push({ fullName: suite.fullName, errors: suite.errors().map(firstLine) });
      }
      for (const test of module.children.allTests()) {
        const result = test.result();
        if (result.state === 'passed') report.passed++;
        else if (result.state === 'failed') entry.tests.push({ fullName: test.fullName, suites: ancestors(test), errors: (result.errors ?? []).map(firstLine) });
      }
      report.modules.push(entry);
    }
    writeFileSync(file, `${JSON.stringify(report)}\n`);
  }
}
