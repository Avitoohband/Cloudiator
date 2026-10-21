/**
 * The release scan's fixed routes and forbidden-material patterns (Task 23.6; moved here from scripts/verify-static.mjs in
 * Task 24.2 so that one definition serves both scans): `npm run verify:static` applies them to every file of an export, and
 * the deployed checks (tests/browser/deployed-checks.ts) to every asset crawled from the deployed origin.
 */

/** The five pages every export carries, as files of the export. */
export const FIXED_ROUTES = ['index.html', 'game/index.html', 'auth/callback/index.html', 'replay/index.html', 'expedition/index.html'];

/** Backend material that must never reach the browser. */
export const FORBIDDEN = [
  /(?:SUPABASE_)?SERVICE_ROLE(?:_KEY)?/i,
  /SUPABASE_SECRET_KEY/i,
  /(?:GAME_)?WORKER_(?:SECRET|TOKEN|KEY|AUTH)/i,
  /sb_secret_[a-zA-Z0-9_-]+/,
  // Next's router uses seed:null/seed:identifier. Private game seeds are string inputs.
  // Quotes can have repeated backslashes when JSON is nested in JavaScript strings.
  /\bseed(?:\\*["'])?\s*[:=]\s*\\*["'`]/i,
  /\b(?:private_?seed|private_?plan)(?:\\*["'])?\s*:/i,
  /(?:encounter_?plan|private_?fixture_?plan|future_?opponent_?snapshot)/i,
  // Task 23.6 (C27): any JWT (three base64url segments, the first a JSON header). The browser uses only the publishable key.
  // It starts at a word boundary, or right after a percent-encoded byte (`Bearer%20eyJ…`) or an escape (`\n`, `\t`, `\u0022`,
  // `\x22`), whose last character is a letter or digit (fix round 1).
  /(?:(?<![A-Za-z0-9_-])|(?<=%[0-9A-Fa-f]{2})|(?<=\\[nrtbfv0])|(?<=\\u[0-9A-Fa-f]{4})|(?<=\\x[0-9A-Fa-f]{2}))eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  // ...and `service_role` base64- or base64url-encoded at any of its three byte alignments (a JWT payload, an encoded key).
  ...base64Needles('service_role').map(needle => new RegExp(needle.replace(/[+/]/g, '\\$&'))),
];
/**
 * The parts of `text`'s base64 encodings that do not depend on the bytes around it: for each start offset modulo 3, the
 * characters whose six bits all come from `text`, in the standard and the URL-safe alphabet.
 * @param {string} text
 */
function base64Needles(text) {
  const needles = new Set();
  for (let offset = 0; offset < 3; offset++) {
    const encoded = Buffer.from('\0'.repeat(offset) + text).toString('base64');
    const inner = encoded.slice(Math.ceil((offset * 8) / 6), Math.floor(((offset + text.length) * 8) / 6));
    needles.add(inner);
    needles.add(inner.replace(/\+/g, '-').replace(/\//g, '_'));
  }
  return [...needles];
}
// The fixture preview (its gateway and sample data) exists only in development builds with fixtures enabled; every
// export this scanner checks is a production build, where next.config.ts forces NEXT_PUBLIC_FIXTURE_ENABLED off, so
// its lazy chunk must be absent (final review Minor 4). Markers: the fixture gateway's own refusal, and the sample
// summaries' receipt ids.
export const FIXTURE_MARKERS = ['unavailable in the fixture preview', 'fixture-receipt-'];

/**
 * What the scan refuses in one asset's text: `backend` (any FORBIDDEN pattern) and `fixture` (fixture preview data). It
 * names the kinds only, never the matched text.
 * @param {string} content
 * @returns {('backend' | 'fixture')[]}
 */
export function forbiddenMaterial(content) {
  /** @type {('backend' | 'fixture')[]} */
  const found = [];
  if (FORBIDDEN.some((pattern) => pattern.test(content))) found.push('backend');
  if (FIXTURE_MARKERS.some((marker) => content.includes(marker))) found.push('fixture');
  return found;
}
