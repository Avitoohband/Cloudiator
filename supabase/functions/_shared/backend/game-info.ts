import type { Actor } from './auth.ts';
import { jsonResponse, preflightResponse, readCommandBody } from './http.ts';

type Tab = 'wiki' | 'future';
type RequestBody = { action: 'read'; tab: Tab } | { action: 'publish'; tab: Tab; expectedVersion: number } |
  { action: 'save'; tab: Tab; expectedVersion: number; document: Record<string, unknown> };

type Dependencies = {
  allowedOrigins: readonly string[];
  verifyOwner(request: Request): Promise<Actor>;
  verifyMcp(authorization: string): Promise<boolean>;
  edit(actorId: string | null, mcp: boolean, input: RequestBody): Promise<unknown>;
};

const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function parse(input: unknown): RequestBody | null {
  if (!object(input) || (input.tab !== 'wiki' && input.tab !== 'future')) return null;
  const { action, tab, expectedVersion, document } = input;
  const size = Object.keys(input).length;
  if (action === 'read' && size === 2) return { action, tab };
  if (typeof expectedVersion !== 'number' || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0) return null;
  if (action === 'publish' && size === 3) return { action, tab, expectedVersion };
  if (action === 'save' && size === 4 && object(document)) return { action, tab, expectedVersion, document };
  return null;
}

/** A deployment can enable the owner editor before it provisions a separate MCP credential. */
export async function createMcpVerifier(token: string | undefined) {
  if (!token) return async () => false;
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(token)) throw Error('Invalid Game Info MCP configuration');
  const digest = async (value: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  const expected = await digest(token);
  return async (authorization: string) => {
    if (!/^Bearer [A-Za-z0-9_-]{43,128}$/i.test(authorization)) return false;
    const candidate = await digest(authorization.slice(7));
    let difference = 0;
    for (let index = 0; index < expected.length; index++) difference |= expected[index] ^ candidate[index];
    return difference === 0;
  };
}

const errorStatus = { forbidden: 403, conflict: 409, invalid: 400, unavailable: 503 } as const;
type Refusal = keyof typeof errorStatus;

export function createGameInfoHandler(deps: Dependencies) {
  return async (request: Request): Promise<Response> => {
    const origin = request.headers.get('Origin');
    const fail = (code: Refusal, allowedOrigin = origin) => jsonResponse({ ok: false, code }, errorStatus[code], allowedOrigin);
    if (origin !== null && !deps.allowedOrigins.includes(origin)) return fail('forbidden', null);
    if (request.method === 'OPTIONS') return preflightResponse(origin);
    if (request.method !== 'POST') return jsonResponse({ ok: false, code: 'invalid' }, 405, origin);

    let input: RequestBody | null;
    try { input = parse(await readCommandBody(request)); } catch { return fail('invalid'); }
    if (!input) return fail('invalid');
    const authorization = request.headers.get('Authorization');
    if (!authorization) return fail('forbidden');

    const mcp = origin === null && await deps.verifyMcp(authorization);
    if (mcp && input.action === 'publish') return fail('forbidden');
    let actorId: string | null = null;
    if (!mcp) {
      try { actorId = (await deps.verifyOwner(request)).userId; } catch { return fail('forbidden'); }
    }

    try {
      const result = await deps.edit(actorId, mcp, input);
      if (object(result) && result.ok === true && typeof result.version === 'number' && Number.isSafeInteger(result.version) &&
          result.version >= 0 && object(result.document)) {
        return jsonResponse({ ok: true, version: result.version, document: result.document }, 200, origin);
      }
      if (object(result) && result.ok === false && typeof result.code === 'string' && Object.hasOwn(errorStatus, result.code)) {
        return fail(result.code as Refusal);
      }
    } catch { /* Internal errors are intentionally absent from the response. */ }
    return fail('unavailable');
  };
}
