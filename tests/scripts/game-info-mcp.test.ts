import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { describe, expect, it } from 'vitest';

const token = 'fixture-editor-token';

describe('Game Info MCP', () => {
  it('lists draft tools and forwards both tabs while refusing publication and redirects', async () => {
    const calls: { path: string | undefined; authorization: string | undefined; input: Record<string, unknown> }[] = [];
    const server = createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
      calls.push({ path: request.url, authorization: request.headers.authorization, input });
      if (input.expectedVersion === 2) {
        response.writeHead(409, { 'Content-Type': 'application/json' }).end('{"ok":false,"code":"conflict"}');
      } else if (input.expectedVersion === 3) {
        response.writeHead(307, { Location: '/other' }).end();
      } else {
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, version: 2, document: { entries: [] } }));
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('Test HTTP address is missing');
    const child = spawn(process.execPath, ['scripts/game-info-mcp.mjs'], { stdio: ['pipe', 'pipe', 'pipe'], env: {
      NODE_ENV: 'test', PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
      CLOUDIATOR_GAME_INFO_MCP_URL: `http://127.0.0.1:${address.port}/functions/v1/game-info`,
      CLOUDIATOR_GAME_INFO_MCP_TOKEN: token,
    } });
    const exit = once(child, 'close');
    const lines = createInterface({ input: child.stdout });
    const replies = lines[Symbol.asyncIterator]();
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    let nextId = 0;
    async function call(method: string, params: Record<string, unknown> = {}) {
      const id = ++nextId;
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      const next = await replies.next();
      if (next.done) throw Error(`MCP process closed before reply to ${method}`);
      const reply = JSON.parse(next.value);
      expect(reply.id).toBe(id);
      return reply;
    }

    try {
      const init = await call('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
      expect(init.result).toMatchObject({ protocolVersion: '2025-11-25', capabilities: { tools: {} } });
      child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
      const tools = (await call('tools/list')).result.tools;
      expect(tools.map((tool: { name: string }) => tool.name)).toEqual(['game_info_list_tabs', 'game_info_read_draft', 'game_info_save_draft']);
      const run = (name: string, args: Record<string, unknown>) => call('tools/call', { name, arguments: args });
      expect((await run('game_info_list_tabs', {})).result.structuredContent).toEqual({ tabs: ['wiki', 'future'] });
      expect((await run('game_info_read_draft', { tab: 'wiki' })).result.structuredContent.version).toBe(2);
      const save = { tab: 'future', expectedVersion: 1, document: { entries: [{ id: 'parties', title: 'Parties', body: 'Invite teammates.' }] } };
      expect((await run('game_info_save_draft', save)).result.structuredContent.version).toBe(2);
      expect((await run('game_info_publish', save)).error.code).toBe(-32602);
      expect((await run('game_info_save_draft', { ...save, action: 'publish' })).error.code).toBe(-32602);
      expect((await run('game_info_save_draft', { ...save, expectedVersion: 2 })).result).toMatchObject({ isError: true, structuredContent: { code: 'conflict' } });
      expect((await run('game_info_save_draft', { ...save, expectedVersion: 3 })).result).toMatchObject({ isError: true, structuredContent: { code: 'unavailable' } });
      expect(calls.map(({ input }) => input.action)).toEqual(['read', 'save', 'save', 'save']);
      expect(calls.every(({ path, authorization }) => path === '/functions/v1/game-info' && authorization === `Bearer ${token}`)).toBe(true);
    } finally {
      child.stdin.end();
      await exit;
      lines.close();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
    expect(stderr).toBe('');
  });
});
