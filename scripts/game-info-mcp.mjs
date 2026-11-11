import { createInterface } from 'node:readline';

const protocol = '2025-11-25';
const tabs = ['wiki', 'future'];
const tabSchema = { type: 'string', enum: tabs };
const schema = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const tools = [
  { name: 'game_info_list_tabs', description: 'List the editable Game Info tabs.', inputSchema: schema({}), annotations: { readOnlyHint: true } },
  { name: 'game_info_read_draft', description: 'Read the current draft and version of a Game Info tab.', inputSchema: schema({ tab: tabSchema }), annotations: { readOnlyHint: true } },
  { name: 'game_info_save_draft', description: 'Replace a Game Info draft using the version you last read. The owner publishes separately.', inputSchema: schema({
    tab: tabSchema, expectedVersion: { type: 'integer', minimum: 0 }, document: { type: 'object',
      description: 'Preserve ordered entries with id, title and body. Future entries may include patch. Wiki has two videos, each a YouTube URL or null.' },
  }) },
];

const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value);
const refusalCodes = new Set(['forbidden', 'conflict', 'invalid', 'unavailable']);

function configuration() {
  const endpoint = new URL(process.env.CLOUDIATOR_GAME_INFO_MCP_URL);
  const token = process.env.CLOUDIATOR_GAME_INFO_MCP_TOKEN;
  const loopback = endpoint.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname);
  if ((!loopback && endpoint.protocol !== 'https:') || endpoint.pathname !== '/functions/v1/game-info' ||
      endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !token || token.length > 512 || !/^\S+$/.test(token)) {
    throw new Error('Invalid Game Info MCP configuration');
  }
  return { endpoint, token };
}

function toolResult(data, isError = false) {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, isError };
}

async function forward(config, command) {
  try {
    const response = await fetch(config.endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(command),
    });
    const data = await response.json();
    if (response.ok && data?.ok === true && Number.isSafeInteger(data.version) && data.version >= 0 && isObject(data.document)) {
      return toolResult({ tab: command.tab, version: data.version, document: data.document });
    }
    if (data?.ok === false && refusalCodes.has(data.code)) return toolResult({ code: data.code }, true);
  } catch { /* Keep transport errors and credential values out of tool output. */ }
  return toolResult({ code: 'unavailable' }, true);
}

function validArguments(tool, args) {
  if (!isObject(args)) return false;
  const { required } = tool.inputSchema;
  if (Object.keys(args).length !== required.length || !required.every(key => Object.hasOwn(args, key))) return false;
  if (required.includes('tab') && !tabs.includes(args.tab)) return false;
  return !required.includes('document') || (isObject(args.document) && Number.isSafeInteger(args.expectedVersion) && args.expectedVersion >= 0);
}

async function serve(config) {
  let initialized = false;
  let ready = false;
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const send = (id, payload) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, ...payload }) + '\n');
  const reject = (id, code, message) => send(id, { error: { code, message } });

  for await (const line of lines) {
    let request;
    try { request = JSON.parse(line); }
    catch { reject(null, -32700, 'Parse error'); continue; }
    if (!isObject(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
      reject(null, -32600, 'Invalid request');
      continue;
    }
    const { id, method, params } = request;
    if (id === undefined) {
      if (method === 'notifications/initialized' && initialized) ready = true;
      continue;
    }
    if (typeof id !== 'string' && !Number.isSafeInteger(id)) { reject(null, -32600, 'Invalid request id'); continue; }
    if (method === 'initialize' && !initialized && typeof params?.protocolVersion === 'string') {
      initialized = true;
      send(id, { result: { protocolVersion: protocol, capabilities: { tools: {} }, serverInfo: { name: 'cloudiator-game-info', version: '1.0.0' } } });
    } else if (method === 'ping') {
      send(id, { result: {} });
    } else if (!ready) {
      reject(id, -32000, 'Server is not initialized');
    } else if (method === 'tools/list') {
      send(id, { result: { tools } });
    } else if (method === 'tools/call') {
      const tool = tools.find(candidate => candidate.name === params?.name);
      const args = params?.arguments ?? {};
      if (!tool || !validArguments(tool, args)) { reject(id, -32602, 'Unknown tool or invalid arguments'); continue; }
      if (tool.name === 'game_info_list_tabs') send(id, { result: toolResult({ tabs }) });
      else send(id, { result: await forward(config, { action: tool.name === 'game_info_read_draft' ? 'read' : 'save', ...args }) });
    } else {
      reject(id, -32601, 'Method not found');
    }
  }
}

try { await serve(configuration()); }
catch {
  process.stderr.write('Game Info MCP could not start. Check the endpoint and scoped credential configuration.\n');
  process.exitCode = 1;
}
