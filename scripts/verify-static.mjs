import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? 'out');
const failures = [];
for (const route of ['index.html', 'game/index.html', 'auth/callback/index.html', 'replay/index.html', 'expedition/index.html']) {
  if (!existsSync(join(root, route))) failures.push(`Missing fixed route: ${route}`);
}
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
];
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
  console.log(`Static export verified: 5 fixed routes; ${scanned} assets scanned; no forbidden backend material; no fixture preview data.`);
}
