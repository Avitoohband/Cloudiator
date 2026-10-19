/**
 * Task 23.6 (C23): the gate's output is pristine. A measurement a suite records as evidence (a read size, a boundary's
 * publication times, a catch-up's rounds) is printed only behind the explicit switch CLOUDIATOR_MEASUREMENTS=1, or when the
 * run asked for it (`always`, as scripts/resource-report.mjs does through CAPACITY_REPORT_DIR). tests/harness.test.ts keeps
 * every other console call out of the database, browser and fixture suites.
 */
export function recordMeasurement(label: string, value: unknown, always = false): void {
  if (!always && process.env.CLOUDIATOR_MEASUREMENTS !== '1') return;
  console.info(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
}
