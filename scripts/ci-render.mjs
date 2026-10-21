/**
 * The controller's CI exception (Task 24.0c, 2026-10-20). A GitHub-hosted runner has no GPU, so Chrome renders WebGL in
 * software: the first Actions run (39452911203) failed only in the development browser step, 51 of 576 tests, almost all
 * 30 s test timeouts while the camp or a scene rendered. `.github/workflows/checks.yml` sets CLOUDIATOR_CI_RENDER=exclude for
 * the release gate; then the development projects of playwright.config.ts leave out the tests tagged @render, and
 * scripts/verify.mjs says how many in its summary. Unset (every local run, and the local `npm run verify`, the gate of
 * record), nothing is left out. The production gate never leaves anything out. The tagged tests and why each is tagged are
 * in docs/implementation/task-24.0c-report.md.
 */

/** The variable checks.yml sets. */
export const CI_RENDER_ENV = 'CLOUDIATOR_CI_RENDER';
/** The Playwright tag of a render-bound test: `test('…', { tag: '@render' }, …)`. */
export const RENDER_TAG = '@render';
/**
 * Matches the tag in the string Playwright matches `grep`/`grepInvert` against (the project, file and titles, then the tags,
 * joined by spaces): the tag itself only, never a longer tag such as `@rendering`.
 */
export const RENDER_PATTERN = /(?:^|\s)@render(?:\s|$)/;

/**
 * The development projects' `grepInvert`: RENDER_PATTERN when CLOUDIATOR_CI_RENDER is `exclude`, otherwise undefined; always
 * undefined for the production gate. Any other non-empty value throws, so a mistyped value never runs a gate whose scope
 * nobody chose.
 * @param {Record<string, string | undefined>} [env]
 * @param {{ production?: boolean }} [options]
 * @returns {RegExp | undefined}
 */
export function renderExclusion(env = process.env, { production = false } = {}) {
  const value = env[CI_RENDER_ENV];
  if (value === undefined || value === '') return undefined;
  if (value !== 'exclude') throw new Error(`${CI_RENDER_ENV} must be unset or "exclude", not "${value}"`);
  return production ? undefined : RENDER_PATTERN;
}
