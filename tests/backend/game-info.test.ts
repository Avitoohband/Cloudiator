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
  const handle = createGameInfoHandler({ allowedOrigins: [origin], verifyOwner, verifyMcp: await createMcpVerifier(mcpToken), edit });
  const send = (body: unknown, token?: string, from?: string) => handle(new Request('https://api.example/functions/v1/game-info', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(from ? { Origin: from } : {}) }, body: JSON.stringify(body),
  }));
  return { edit, handle, send, verifyOwner };
}

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
