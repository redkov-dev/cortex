import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { Miniflare } from 'miniflare';

export const OWNER = 'https://owner.magnt.ru';
export const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'owner-integration-test', version: '0.2.0' },
  'io.modelcontextprotocol/clientCapabilities': {} };
export async function fixture(t, { overrides = {}, through = 6, gatewayLimit = 10000, loginLimit = 10000 } = {}) {
  const modules = {};
  const directory = process.env.MAGNT_TEST_BUNDLE ?? 'dist-local';
  for (const file of (await readdir(directory)).filter(n => n.endsWith('.js') || n.endsWith('.sql'))) {
    modules[file] = { type: file.endsWith('.sql') ? 'text' : 'esm', contents: await readFile(directory + '/' + file, 'utf8') };
  }
  for (const type of ['owner', 'public']) modules[type + '-test.js'] = { type: 'esm', contents: `import worker from './${type === 'owner' ? 'owner-gateway' : 'public-gateway'}.js';
    export default { fetch(request, env, ctx) { const headers = new Headers(request.headers); headers.set('host', new URL(request.url).host);
      if (headers.has('x-test-origin')) { headers.set('origin', headers.get('x-test-origin')); headers.delete('x-test-origin'); }
      return worker.fetch(new Request(request, { headers }), env, ctx); } };` };
  modules['control-test.js'] = { type: 'esm', contents: `export default { fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === '/direct-owner') return env.OWNER_DIRECT.fetch(new Request('https://owner.magnt.ru/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
    return env.CONTROL.fetch(request);
  } };` };
  const logs = [], requests = [], telegramMessages = [];
  const config = { OWNER_MCP_ENABLED: 'true', OWNER_MCP_WRITE_ENABLED: 'true', OWNER_GITHUB_ID: '1', OWNER_AUTH_EPOCH: '1',
    OWNER_DCR_ENABLED: 'true', OWNER_GITHUB_CLIENT_ID: 'test-client', OWNER_GITHUB_CLIENT_SECRET: 'TEST_GITHUB_SECRET', ...overrides };
  const base = { compatibilityDate: '2026-09-23', compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'] };
  const textBindings = Object.fromEntries(Object.entries(config).filter(([,v]) => v !== undefined).map(([key,value]) => [key, { type: 'text', value }]));
  const outbound = { type: 'fetcher', handler: async request => {
    requests.push(request.url);
    if (request.url === 'https://api.telegram.org/bot' + config.TELEGRAM_BOT_TOKEN + '/sendMessage') {
      telegramMessages.push(await request.json());
      return Response.json({ ok: true, result: { message_id: telegramMessages.length,
        chat: { id: Number(config.TELEGRAM_OWNER_CHAT_ID), type: 'private' } } });
    }
    if (request.url === 'https://github.com/login/oauth/access_token') {
      const data = new URLSearchParams(await request.text());
      assert.equal(data.get('client_secret'), 'TEST_GITHUB_SECRET');
      assert.ok(data.get('code_verifier'));
      return Response.json({ access_token: 'gho_' + data.get('code') });
    }
    if (request.url === 'https://api.github.com/user') return Response.json({ id: request.headers.get('authorization')?.endsWith('foreign') ? 2 : 1, type: 'User' });
    if (request.url.startsWith('https://chatgpt.com/oauth/')) return Response.json({ client_id: request.url,
      client_name: 'ChatGPT', redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'], token_endpoint_auth_method: 'none' });
    if (request.url.startsWith('https://raw.githubusercontent.com/')) return new Response('public site');
    throw new Error('Unexpected outbound host');
  } };
  const worker = (name, mainModule, env, dev = {}) => ({ config: { ...base, name, manifest: { mainModule, modules }, env }, dev });
  const mf = new Miniflare({ cf: false, logRequests: false, telemetry: { enabled: false }, handleStructuredLogs: e => logs.push(e),
    workers: [
      worker('owner-edge', 'owner-test.js', { OWNER_CORE: { type: 'worker', worker: 'core', exportName: 'OwnerApi' },
        OWNER_REQUEST_LIMIT: { type: 'rate-limit', namespace: '1001', simple: { limit: gatewayLimit, period: 60 } },
        OWNER_LOGIN_LIMIT: { type: 'rate-limit', namespace: '1002', simple: { limit: loginLimit, period: 60 } } }),
      worker('public-edge', 'public-test.js', { PUBLIC_CORE: { type: 'worker', worker: 'core', exportName: 'PublicApi' } }, { outboundService: outbound }),
      worker('core', 'test-core.js', { CONTACTS: { type: 'd1', id: crypto.randomUUID() }, OAUTH_KV: { type: 'kv', id: crypto.randomUUID() }, ...textBindings }, { outboundService: outbound }),
      worker('control', 'control-test.js', { CONTROL: { type: 'worker', worker: 'core', exportName: 'TestControl' }, OWNER_DIRECT: { type: 'worker', worker: 'core', exportName: 'OwnerApi' } }),
    ] });
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('CONTACTS', 'core');
  for (const name of (await readdir('migrations')).filter(n => n.endsWith('.sql') && Number(n.slice(0,4)) <= through).sort()) {
    const sql = (await readFile('migrations/' + name, 'utf8')).replace(/--[^\n]*/g, '');
    await db.batch(sql.split(';').filter(s => s.trim()).map(s => db.prepare(s)));
  }
  const [edge, pub, core, control] = await Promise.all(['owner-edge', 'public-edge', 'core', 'control'].map(name => mf.getWorker(name)));
  const mint = async options => {
    const response = await control.fetch('https://fixture.local/mint', { method: 'POST', body: JSON.stringify(options ?? {}) });
    const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value;
  };
  const credentials = await mint();
  // The local Node bridge rejects browser Origin before workerd; restore it inside
  // the test-only entrypoint so assertions exercise production origin validation.
  const browserFetch = target => ({ fetch(url, init = {}) {
    const headers = new Headers(init.headers);
    if (headers.has('origin')) { headers.set('x-test-origin', headers.get('origin')); headers.delete('origin'); }
    return target.fetch(String(url), { ...init, headers });
  } });
  const browserEdge = browserFetch(edge);
  const fetchWorker = (url, init) => (new URL(String(url)).hostname === 'magnt.ru' ? pub : browserEdge).fetch(String(url), init);
  const raw = (method, params = {}, { token = credentials.access_token, path = '/mcp', headers = {}, public: isPublic = false } = {}) => fetchWorker((isPublic ? 'https://magnt.ru' : OWNER) + path, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': method, ...(method === 'tools/call' ? { 'Mcp-Name': params.name } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: meta } }),
  });
  const call = async (name, args = {}, options) => {
    const response = await raw('tools/call', { name, arguments: args }, options);
    const text = await response.text(); assert.equal(response.status, 200, text);
    const body = JSON.parse(text); assert.ok(body.result, text);
    return { ...body.result, value: body.result.structuredContent, size: new TextEncoder().encode(text).byteLength };
  };
  return { mf, db, raw, call, logs, requests, telegramMessages, fetchWorker, edge: browserEdge, pub, core, control, credentials, mint };
}
