import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { GALLERY, connectOrigin, headersFile } from './build-headers.mjs';

const root = resolve(process.argv[2] ?? 'out');
const failures = [];
for (const route of ['index.html', 'game/index.html', 'auth/callback/index.html', 'replay/index.html', 'expedition/index.html']) {
  if (!existsSync(join(root, route))) failures.push(`Missing fixed route: ${route}`);
}
// Task 23.6 (plan Decision 7): the export carries exactly the `_headers` scripts/build-headers.mjs generates for one allowed
// connect-src origin (or none). Any other content (a widened directive, a missing header or rule, a report-only policy, an
// unexpected origin) fails.
let connect = 'none';
const headersPath = join(root, '_headers');
if (!existsSync(headersPath)) failures.push('Missing _headers: build with npm run build (scripts/build-headers.mjs).');
else {
  const text = readFileSync(headersPath, 'utf8');
  const origin = /^ {2}Content-Security-Policy: .*\bconnect-src 'self'(?: (\S+?))?;/m.exec(text)?.[1] ?? null;
  let expected = null;
  try { expected = headersFile(connectOrigin(origin ?? undefined)); } catch { failures.push(`Unexpected connect-src origin in _headers: ${origin}`); }
  if (expected !== null && text !== expected) failures.push('Unexpected _headers content: it must be exactly what scripts/build-headers.mjs writes.');
  if (origin) connect = origin;
}
// Plan Decision 2: the hand-written art gallery is a development tool, never part of a production export.
if (existsSync(join(root, GALLERY))) failures.push(`Development-only art gallery in the export: ${GALLERY}`);
const forbidden = [
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
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  // ...and `service_role` base64- or base64url-encoded at any of its three byte alignments (a JWT payload, an encoded key).
  ...base64Needles('service_role').map(needle => new RegExp(needle.replace(/[+/]/g, '\\$&'))),
];
/**
 * The parts of `text`'s base64 encodings that do not depend on the bytes around it: for each start offset modulo 3, the
 * characters whose six bits all come from `text`, in the standard and the URL-safe alphabet.
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
const fixtureMarkers = ['unavailable in the fixture preview', 'fixture-receipt-'];
let scanned = 0;
function scan(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isSymbolicLink()) { failures.push(`Unexpected symlink: ${relative(root, file)}`); continue; }
    if (entry.isDirectory()) { scan(file); continue; }
    scanned++;
    // Search every asset, including sourcemaps, JSON, and binary files with embedded strings.
    const content = readFileSync(file).toString('utf8');
    if (forbidden.some((pattern) => pattern.test(content))) failures.push(`Forbidden backend material in ${relative(root, file)}`);
    if (fixtureMarkers.some((marker) => content.includes(marker))) failures.push(`Fixture preview data in ${relative(root, file)}`);
  }
}
if (existsSync(root)) scan(root);
if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Static export verified: 5 fixed routes; _headers as generated (connect-src 'self'${connect === 'none' ? '' : ` ${connect}`}); `
    + `no art gallery; ${scanned} assets scanned; no forbidden backend material; no fixture preview data.`);
}
