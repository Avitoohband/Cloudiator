import { describe, expect, it, vi } from 'vitest';
import { createGameInfoHandler, createMcpVerifier } from '../../supabase/functions/_shared/backend/game-info.ts';

const origin = 'https://cloudiator.example';
const ownerId = '11111111-1111-4111-8111-111111111111';
const mcpToken = 'fixture-game-info-mcp-token-not-a-production-credential';
const document = { entries: [{ id: 'party', title: 'Parties', body: 'Invite teammates.' }] };

async function setup() {
  const verifyOwner = vi.fn(async (request: Request) => {
    if (request.headers.get('Authorization') !== 'Bearer owner-session') throw Error('unauthenticated');
    return { userId: ownerId };
  });
  const edit = vi.fn(async () => ({ ok: true, version: 2, document }));
  const feedback = vi.fn(async (_actorId: string | null, _mcp: boolean, input: { action: string }): Promise<unknown> => input.action === 'list'
    ? { ok: true, items: [item], newCount: 1 } : input.action === 'mark-read' ? { ok: true, id: 7, status: 'read' }
    : input.action === 'suggest' ? { ok: true, id: 7, status: 'new', suggestedAtMs: 1_791_590_460_000 } : { ok: true, id: 7, status: 'answered', messageId: 31 });
  const handle = createGameInfoHandler({ allowedOrigins: [origin], verifyOwner, verifyMcp: await createMcpVerifier(mcpToken), edit, feedback });
  const send = (body: unknown, token?: string, from?: string) => handle(new Request('https://api.example/functions/v1/game-info', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(from ? { Origin: from } : {}) }, body: JSON.stringify(body),
  }));
  return { edit, feedback, handle, send, verifyOwner };
}
/** One item of the owner's feedback list (M34, M36), as review_feedback returns it. */
const item = { id: 7, category: 'bug', text: 'The Arena timer shows a wrong number.', details: null, status: 'new', createdAtMs: 1_791_590_400_000,
  gladiatorName: 'Aster', answer: null, answeredAtMs: null, answeredVia: null, suggestion: 'Thanks, we are on it.', suggestedAtMs: 1_791_590_460_000 };

describe('Game Info editor endpoint', () => {
  it('passes only the verified owner identity to publish', async () => {
    const { edit, send } = await setup();
    const publish = { action: 'publish', tab: 'wiki', expectedVersion: 1 };
    const refused = await send({ ...publish, actorId: ownerId }, 'owner-session', origin);
    expect(refused.status).toBe(400);
    expect(edit).not.toHaveBeenCalled();
    const response = await send(publish, 'owner-session', origin);
    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(edit).toHaveBeenCalledWith(ownerId, false, publish);
  });

  it('allows the separate MCP credential to read and save but never publish', async () => {
    const { edit, send, verifyOwner } = await setup();
    const save = { action: 'save', tab: 'future', expectedVersion: 1, document };
    const publish = { action: 'publish', tab: 'future', expectedVersion: 1 };
    expect((await send(save, mcpToken)).status).toBe(200);
    expect((await send(publish, mcpToken)).status).toBe(403);
    expect((await send({ action: 'read', tab: 'wiki' }, mcpToken)).status).toBe(200);
    expect(edit.mock.calls).toEqual([[null, true, save], [null, true, { action: 'read', tab: 'wiki' }]]);
    expect(verifyOwner).not.toHaveBeenCalled();
  });

  it('rejects unsigned, invalid, oversized, and foreign-origin requests without writing', async () => {
    const { edit, send } = await setup();
    const read = { action: 'read', tab: 'wiki' };
    expect((await send(read)).status).toBe(403);
    expect((await send(read, mcpToken + 'x')).status).toBe(403);
    const foreign = await send(read, 'owner-session', 'https://other.example');
    expect(foreign.status).toBe(403);
    expect(foreign.headers.has('Access-Control-Allow-Origin')).toBe(false);
    expect((await send({ action: 'save', tab: 'future', expectedVersion: 1, document: { entries: ['x'.repeat(16_384)] } }, mcpToken)).status).toBe(400);
    expect(edit).not.toHaveBeenCalled();
  });
});

// Patch 1.9 (M34): the owner's feedback actions ride on the same endpoint, for the signed-in editor (the SQL checks the allowlist).
// M36: the MCP credential (Claude) may list, mark read and suggest an answer, never send one; only the editor answers, from a
// suggestion (`fromSuggestion: true`) or in their own words, and the editor never suggests.
describe('Game Info feedback actions', () => {
  const list = { tab: 'feedback', action: 'list', filter: 'new' };
  const markRead = { tab: 'feedback', action: 'mark-read', id: 7 };
  const answer = { tab: 'feedback', action: 'answer', id: 7, text: 'Thank you, found it. It is fixed in the next patch.' };
  const approve = { ...answer, fromSuggestion: true };
  const suggest = { tab: 'feedback', action: 'suggest', id: 7, text: 'Thanks, we are on it.' };

  it('passes the verified owner and the parsed action to the feedback store, and answers its result', async () => {
    const { edit, feedback, send } = await setup();
    const listed = await send(list, 'owner-session', origin);
    expect([listed.status, await listed.json()]).toEqual([200, { ok: true, items: [item], newCount: 1 }]);
    expect(listed.headers.get('Access-Control-Allow-Origin')).toBe(origin);
    expect(listed.headers.get('Cache-Control')).toBe('no-store');
    const read = await send(markRead, 'owner-session', origin);
    expect([read.status, await read.json()]).toEqual([200, { ok: true, id: 7, status: 'read' }]);
    const answered = await send(answer, 'owner-session', origin);
    expect([answered.status, await answered.json()]).toEqual([200, { ok: true, id: 7, status: 'answered', messageId: 31 }]);
    for (const filter of ['answered', 'all']) expect((await send({ ...list, filter }, 'owner-session', origin)).status).toBe(200);
    const approved = await send(approve, 'owner-session', origin);
    expect([approved.status, await approved.json()]).toEqual([200, { ok: true, id: 7, status: 'answered', messageId: 31 }]);
    expect(feedback.mock.calls).toEqual([[ownerId, false, list], [ownerId, false, markRead], [ownerId, false, answer],
      [ownerId, false, { ...list, filter: 'answered' }], [ownerId, false, { ...list, filter: 'all' }], [ownerId, false, approve]]);
    expect(edit).not.toHaveBeenCalled();
  });

  it('lets the MCP credential list, mark read and suggest (no account, mcp true), never answer or publish', async () => {
    const { edit, feedback, send, verifyOwner } = await setup();
    const listed = await send(list, mcpToken);
    expect([listed.status, await listed.json()]).toEqual([200, { ok: true, items: [item], newCount: 1 }]);
    expect((await send(markRead, mcpToken)).status).toBe(200);
    const suggested = await send(suggest, mcpToken);
    expect([suggested.status, await suggested.json()]).toEqual([200, { ok: true, id: 7, status: 'new', suggestedAtMs: 1_791_590_460_000 }]);
    expect(feedback.mock.calls).toEqual([[null, true, list], [null, true, markRead], [null, true, suggest]]);
    // Sending is the editor's alone: an answer, even from a suggestion, and publishing are refused before the store.
    for (const body of [answer, approve, { action: 'publish', tab: 'wiki', expectedVersion: 1 }]) {
      expect((await send(body, mcpToken)).status, JSON.stringify(body)).toBe(403);
    }
    expect(feedback).toHaveBeenCalledTimes(3);
    expect(edit).not.toHaveBeenCalled();
    expect(verifyOwner).not.toHaveBeenCalled();
  });

  it('refuses a suggestion from the editor, and a malformed suggestion or approval, before the store', async () => {
    const { feedback, send } = await setup();
    expect((await send(suggest, 'owner-session', origin)).status).toBe(403);
    for (const bad of [{ ...suggest, text: '  ' }, { ...suggest, text: 'x'.repeat(2001) }, { ...suggest, text: 3 }, { tab: 'feedback', action: 'suggest', id: 7 },
      { ...suggest, id: 0 }, { ...suggest, fromSuggestion: true }]) {
      expect((await send(bad, mcpToken)).status, JSON.stringify(bad)).toBe(400);
    }
    for (const bad of [{ ...answer, fromSuggestion: false }, { ...answer, fromSuggestion: 'true' }, { ...answer, fromSuggestion: 1 },
      { ...answer, fromSuggestion: null }, { ...markRead, fromSuggestion: true }]) {
      expect((await send(bad, 'owner-session', origin)).status, JSON.stringify(bad)).toBe(400);
    }
    expect(feedback).not.toHaveBeenCalled();
    // A store answer that is not a suggestion's success is unavailable.
    feedback.mockResolvedValueOnce({ ok: true, id: 7, status: 'answered', suggestedAtMs: 1 });
    expect((await send(suggest, mcpToken)).status).toBe(503);
    feedback.mockResolvedValueOnce({ ok: true, id: 7, status: 'new' });
    expect((await send(suggest, mcpToken)).status).toBe(503);
    feedback.mockResolvedValueOnce({ ok: false, code: 'conflict' });
    expect((await send(suggest, mcpToken)).status).toBe(409);
  });

  it('answers the store refusals and refuses unsigned, foreign and malformed requests before the store', async () => {
    const { feedback, send } = await setup();
    // Another signed-in account: the SQL allowlist answers forbidden.
    feedback.mockResolvedValueOnce({ ok: false, code: 'forbidden' });
    expect((await send(list, 'owner-session', origin)).status).toBe(403);
    feedback.mockResolvedValueOnce({ ok: false, code: 'not-found' });
    expect([...await (async r => [r.status, await r.json()])(await send(markRead, 'owner-session', origin))]).toEqual([404, { ok: false, code: 'not-found' }]);
    feedback.mockResolvedValueOnce({ ok: false, code: 'conflict' });
    expect((await send(answer, 'owner-session', origin)).status).toBe(409);
    // A malformed store answer, or a store failure, is unavailable (never a detail).
    feedback.mockResolvedValueOnce({ ok: true, items: 'many' });
    expect((await send(list, 'owner-session', origin)).status).toBe(503);
    feedback.mockRejectedValueOnce(Error('database detail'));
    const failed = await send(list, 'owner-session', origin);
    expect([failed.status, await failed.json()]).toEqual([503, { ok: false, code: 'unavailable' }]);
    expect(feedback).toHaveBeenCalledTimes(5);
    // Unsigned, a foreign origin, or a malformed action never reaches the store.
    expect((await send(list)).status).toBe(403);
    expect((await send(list, 'owner-session', 'https://other.example')).status).toBe(403);
    for (const bad of [{ ...list, filter: 'read' }, { ...list, filter: null }, { tab: 'feedback', action: 'list' }, { ...list, extra: 1 },
      { ...markRead, id: 0 }, { ...markRead, id: '7' }, { ...markRead, id: 1.5 }, { tab: 'feedback', action: 'mark-read' },
      { ...answer, text: 42 }, { ...answer, text: '   ' }, { ...answer, text: 'x'.repeat(2001) }, { tab: 'feedback', action: 'answer', id: 7 },
      { ...answer, actorId: ownerId }, { tab: 'feedback', action: 'read' }, { tab: 'feedback', action: 'publish', expectedVersion: 1 },
      { tab: 'wiki', action: 'list', filter: 'new' }, { tab: 'feedback', action: 'delete', id: 7 }]) {
      expect((await send(bad, 'owner-session', origin)).status, JSON.stringify(bad)).toBe(400);
    }
    expect(feedback).toHaveBeenCalledTimes(5);
  });
});
