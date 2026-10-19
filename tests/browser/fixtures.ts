// The browser suites' `test` (Task 23.6). Every spec imports `test` and `expect` from here (tests/harness.test.ts checks it).
// - Plan Decision 7: in the production gate (PLAYWRIGHT_STATIC=true, served with the export's own `_headers` by
//   scripts/serve-static.mjs) each test listens for Content-Security-Policy violations in every page of its context and
//   fails on any. The development server sends no policy, so there the listener does nothing.
// - C21 triage: in both gates, a failed test whose context saw a request fail in the host's network stack
//   (tests/browser/host-faults.ts) gets one more error naming that fault after its own errors. scripts/verify.mjs labels the
//   failure a probable host fault in its summary, beside the test's own first error; the test still fails, and nothing is
//   rerun (Task 23.6 fix round 1).
import { test as base, expect } from '@playwright/test';
import { HOST_FAULT_MARKER, isHostFault } from './host-faults';

export * from '@playwright/test';

/** One violation, from the page's `securitypolicyviolation` event or, as a backstop, Chrome's console report. */
export type CspViolation = { source: 'event' | 'console'; directive: string; blocked: string; url: string; text?: string };

const production = process.env.PLAYWRIGHT_STATIC === 'true';
const BINDING = '__cloudiatorCspViolation';

export const test = base.extend<{ cspViolations: CspViolation[]; allowCspViolations: boolean; hostFaults: string[] }>({
  /** Off only for a case that makes a violation on purpose and checks `cspViolations` itself. */
  allowCspViolations: [false, { option: true }],
  cspViolations: [async ({ context, allowCspViolations }, use) => {
    const violations: CspViolation[] = [];
    if (production) {
      await context.exposeBinding(BINDING, (_source, violation: Omit<CspViolation, 'source'>) => { violations.push({ source: 'event', ...violation }); });
      await context.addInitScript(binding => {
        document.addEventListener('securitypolicyviolation', event => {
          const report = (window as unknown as Record<string, (v: unknown) => void>)[binding];
          report?.({ directive: event.effectiveDirective, blocked: event.blockedURI, url: event.documentURI, text: event.sample || undefined });
        }, true);
      }, BINDING);
      context.on('console', message => {
        const text = message.text();
        if (/Content Security Policy/i.test(text)) violations.push({ source: 'console', directive: /directive:? "([^"]+)"/.exec(text)?.[1] ?? '', blocked: '', url: message.page()?.url() ?? '', text });
      });
    }
    await use(violations);
    if (production && !allowCspViolations) expect(violations, 'Content-Security-Policy violations in the production export').toEqual([]);
  }, { auto: true }],
  hostFaults: [async ({ context }, use, testInfo) => {
    const faults: string[] = [];
    context.on('requestfailed', request => {
      const text = request.failure()?.errorText;
      if (isHostFault(text)) faults.push(`${text} for ${request.url()}`);
    });
    await use(faults);
    if (faults.length && testInfo.status !== testInfo.expectedStatus) {
      throw new Error(`${HOST_FAULT_MARKER} ${faults.length} request${faults.length === 1 ? '' : 's'} failed in the host's network stack (${faults.slice(0, 3).join('; ')}).`);
    }
  }, { auto: true }],
});

export { expect };
