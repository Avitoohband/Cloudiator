/**
 * Local-only host for verifying the exported artifact; no application runtime.
 * It applies the export's own `_headers` (written by scripts/build-headers.mjs) the way Cloudflare Pages does: every rule
 * whose path pattern matches adds its headers, a repeated header is joined with ", ", and `_headers` itself is never served.
 * It refuses an export without `_headers`, so the production browser gate always runs under the deployed policy (Task 23.6).
 * CLOUDIATOR_STATIC_ROOT is the export (default `out`), CLOUDIATOR_STATIC_PORT the port on 127.0.0.1 (default 4173).
 */
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { resolve, sep, extname, join } from 'node:path';
// The Cloudflare Pages reading of `_headers` (shared with the deployed checks since Task 24.2).
import { headersFor, parseHeaders } from './build-headers.mjs';

const root = resolve(process.env.CLOUDIATOR_STATIC_ROOT ?? 'out');
const port = Number(process.env.CLOUDIATOR_STATIC_PORT ?? 4173);
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.txt': 'text/plain', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };

if (!existsSync(join(root, '_headers'))) {
  console.error(`No _headers in ${root}: build the export with npm run build (scripts/build-headers.mjs) before serving it.`);
  process.exit(1);
}
const rules = parseHeaders(readFileSync(join(root, '_headers'), 'utf8'));

createServer(async (request, response) => {
  let pathname = '/';
  try {
    pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    const headers = headersFor(rules, pathname);
    let file = resolve(root, `.${pathname}`);
    if (file !== root && !file.startsWith(root + sep)) { response.writeHead(403, headers).end(); return; }
    if (file.toLowerCase() === join(root, '_headers').toLowerCase()) { response.writeHead(404, headers).end('Not found'); return; }
    if ((await stat(file)).isDirectory()) file = resolve(file, 'index.html');
    const bytes = await readFile(file);
    response.writeHead(200, { ...headers, 'Content-Type': mime[extname(file)] ?? 'application/octet-stream' }).end(bytes);
  } catch { response.writeHead(404, headersFor(rules, pathname)).end('Not found'); }
}).listen(port, '127.0.0.1', () => console.log(`Export host ready at http://127.0.0.1:${port}`));
