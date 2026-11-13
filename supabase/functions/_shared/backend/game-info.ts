import type { Actor } from './auth.ts';
import { jsonResponse, preflightResponse, readCommandBody } from './http.ts';
import { validFeedbackAnswer, validFeedbackSuggestion } from '../domain/feedback.ts';

type Tab = 'wiki' | 'future';
type RequestBody = { action: 'read'; tab: Tab } | { action: 'publish'; tab: Tab; expectedVersion: number } |
  { action: 'save'; tab: Tab; expectedVersion: number; document: Record<string, unknown> };
/**
 * Patch 1.9 (M34, M36): the feedback actions. `list` answers {ok, items, newCount} and `mark-read` {ok, id, status}, for a signed-in
 * Game Info editor (public.review_feedback checks the allowlist) and for the MCP credential (Claude). Only the editor sends:
 * `answer` (1 to 2,000 characters once trimmed; `fromSuggestion: true` when it sends Claude's suggestion, as shown or edited)
 * answers {ok, id, status: 'answered', messageId}. Only the MCP credential suggests: `suggest` (1 to 2,000 characters once trimmed)
 * saves a suggested answer the editor may send later, and answers {ok, id, status, suggestedAtMs}; it reaches no player.
 */
export type FeedbackRequest = { tab: 'feedback'; action: 'list'; filter: 'new' | 'answered' | 'all' } | { tab: 'feedback'; action: 'mark-read'; id: number }
  | { tab: 'feedback'; action: 'answer'; id: number; text: string; fromSuggestion?: true } | { tab: 'feedback'; action: 'suggest'; id: number; text: string };

type Dependencies = {
  allowedOrigins: readonly string[];
  verifyOwner(request: Request): Promise<Actor>;
  verifyMcp(authorization: string): Promise<boolean>;
  edit(actorId: string | null, mcp: boolean, input: RequestBody): Promise<unknown>;
  /** The verified editor's account with mcp false, or no account with mcp true for the MCP credential. */
  feedback(actorId: string | null, mcp: boolean, input: FeedbackRequest): Promise<unknown>;
};

const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const whole = (value: unknown, minimum = 0): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;

/** Exactly one feedback action with exactly its keys, or null. */
function parseFeedback(input: Record<string, unknown>): FeedbackRequest | null {
  const { action, filter, id, text } = input;
  const size = Object.keys(input).length;
  if (action === 'list' && size === 3 && (filter === 'new' || filter === 'answered' || filter === 'all')) return { tab: 'feedback', action, filter };
  if (action === 'mark-read' && size === 3 && whole(id, 1)) return { tab: 'feedback', action, id };
  if (action === 'answer' && whole(id, 1) && validFeedbackAnswer(text)) {
    if (size === 4) return { tab: 'feedback', action, id, text };
    if (size === 5 && input.fromSuggestion === true) return { tab: 'feedback', action, id, text, fromSuggestion: true };
  }
  if (action === 'suggest' && size === 4 && whole(id, 1) && validFeedbackSuggestion(text)) return { tab: 'feedback', action, id, text };
  return null;
}

function parse(input: unknown): RequestBody | FeedbackRequest | null {
  if (object(input) && input.tab === 'feedback') return parseFeedback(input);
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

const errorStatus = { forbidden: 403, conflict: 409, invalid: 400, unavailable: 503, 'not-found': 404 } as const;
type Refusal = keyof typeof errorStatus;

/** The store's answer to a feedback action, rebuilt from its expected keys only; null when it is not a success of that action. */
function feedbackAnswer(input: FeedbackRequest, result: unknown) {
  if (!object(result) || result.ok !== true) return null;
  if (input.action === 'list') return Array.isArray(result.items) && whole(result.newCount) ? { ok: true, items: result.items, newCount: result.newCount } : null;
  if (!whole(result.id, 1)) return null;
  if (input.action === 'mark-read') return result.status === 'read' || result.status === 'answered' ? { ok: true, id: result.id, status: result.status } : null;
  if (input.action === 'suggest') {
    return (result.status === 'new' || result.status === 'read') && whole(result.suggestedAtMs)
      ? { ok: true, id: result.id, status: result.status, suggestedAtMs: result.suggestedAtMs } : null;
  }
  return result.status === 'answered' && whole(result.messageId, 1) ? { ok: true, id: result.id, status: 'answered', messageId: result.messageId } : null;
}

export function createGameInfoHandler(deps: Dependencies) {
  return async (request: Request): Promise<Response> => {
    const origin = request.headers.get('Origin');
    const fail = (code: Refusal, allowedOrigin = origin) => jsonResponse({ ok: false, code }, errorStatus[code], allowedOrigin);
    if (origin !== null && !deps.allowedOrigins.includes(origin)) return fail('forbidden', null);
    if (request.method === 'OPTIONS') return preflightResponse(origin);
    if (request.method !== 'POST') return jsonResponse({ ok: false, code: 'invalid' }, 405, origin);

    let input: RequestBody | FeedbackRequest | null;
    try { input = parse(await readCommandBody(request)); } catch { return fail('invalid'); }
    if (!input) return fail('invalid');
    const authorization = request.headers.get('Authorization');
    if (!authorization) return fail('forbidden');

    const mcp = origin === null && await deps.verifyMcp(authorization);
    // Each caller keeps to its own actions. The MCP credential (Claude) reads and saves drafts, lists feedback, marks it read and
    // suggests answers: it never publishes and never sends an answer (M36: only Avi sends, approving or editing a suggestion).
    // The editor never suggests. SQL checks the same again.
    if (mcp && (input.action === 'publish' || (input.tab === 'feedback' && input.action === 'answer'))) return fail('forbidden');
    if (!mcp && input.tab === 'feedback' && input.action === 'suggest') return fail('forbidden');
    let actorId: string | null = null;
    if (!mcp) {
      try { actorId = (await deps.verifyOwner(request)).userId; } catch { return fail('forbidden'); }
    }

    try {
      if (input.tab === 'feedback') {
        const result = await deps.feedback(actorId, mcp, input);
        const answer = feedbackAnswer(input, result);
        if (answer) return jsonResponse(answer, 200, origin);
        if (object(result) && result.ok === false && typeof result.code === 'string' && Object.hasOwn(errorStatus, result.code)) {
          return fail(result.code as Refusal);
        }
        return fail('unavailable');
      }
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
