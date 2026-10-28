import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { build } from 'esbuild';
import { fixture, OWNER } from './support/owner-fixture.mjs';
import { collectEvents, summarizeEvents } from '../scripts/shared-memory-metrics.mjs';

const redirectUri = 'https://chatgpt.com/connector_platform_oauth_redirect';
const scope = 'magnt.owner.read magnt.owner.write offline_access';
function cookies(response, previous = '') {
  const jar = new Map(previous.split('; ').filter(Boolean).map(s => s.split('=')));
  for (const cookie of response.headers.getSetCookie()) {
    const [name, value] = cookie.split(';')[0].split('=');
    if (/max-age=0(?:;|$)/i.test(cookie)) jar.delete(name); else jar.set(name, value);
  }
  return [...jar].map(([key,value]) => key + '=' + value).join('; ');
}
const post = (f, path, fields, headers = {}) => f.edge.fetch(OWNER + path, {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
  body: new URLSearchParams(fields).toString(), redirect: 'manual',
});
async function begin(f, { cimd = false, clientName = 'ChatGPT', redirect = redirectUri, resource = OWNER + '/mcp', requestedScope = scope } = {}) {
  let clientId = 'https://chatgpt.com/oauth/client.json';
  if (!cimd) {
    const registration = await f.edge.fetch(OWNER + '/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: clientName, redirect_uris: [redirect], grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'], token_endpoint_auth_method: 'none' }) });
    const value = await registration.json(); assert.equal(registration.status, 201, JSON.stringify(value)); clientId = value.client_id;
  }
  const verifier = 'p'.repeat(64);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const url = OWNER + '/authorize?' + new URLSearchParams({ response_type: 'code', client_id: clientId,
    redirect_uri: redirect, scope: requestedScope, resource, state: 'chatgpt-client-state', code_challenge: challenge, code_challenge_method: 'S256' });
  const consent = await f.edge.fetch(url);
  const html = await consent.text(); assert.equal(consent.status, 200, html);
  const handle = html.match(/name="handle" value="([^"]+)"/)?.[1]; assert.ok(handle, html);
  assert.equal(consent.headers.get('x-frame-options'), 'DENY');
  assert.equal(consent.headers.get('referrer-policy'), 'strict-origin');
  assert.ok(consent.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
  return { clientId, verifier, handle, cookie: cookies(consent), html, url, scope: requestedScope };
}
async function approve(f, flow) {
  const form = new URLSearchParams({ handle: flow.handle, decision: 'approve' });
  for (const s of flow.scope.split(' ')) form.append('scope', s);
  const response = await post(f, '/authorize', form, { origin: OWNER, cookie: flow.cookie });
  const text = await response.text(); assert.equal(response.status, 302, text);
  const next = new URL(response.headers.get('location'));
  assert.equal(next.origin, 'https://github.com'); assert.equal(next.pathname, '/login/oauth/authorize');
  assert.equal(next.searchParams.get('scope'), null); assert.equal(next.searchParams.get('code_challenge_method'), 'S256');
  return { ...flow, state: next.searchParams.get('state'), cookie: cookies(response, flow.cookie) };
}
async function callback(f, flow, code = 'valid') {
  return f.edge.fetch(OWNER + '/callback?' + new URLSearchParams({ code, state: flow.state }), { headers: { cookie: flow.cookie }, redirect: 'manual' });
}
async function exchange(f, flow, code, verifier = flow.verifier) {
  return post(f, '/oauth/token', { grant_type: 'authorization_code', client_id: flow.clientId,
    redirect_uri: redirectUri, resource: OWNER + '/mcp', code, code_verifier: verifier });
}

test('real OAuth consent, GitHub identity, PKCE and silent refresh work for DCR and CIMD', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const metadata = await (await f.edge.fetch(OWNER + '/.well-known/oauth-authorization-server')).json();
  assert.ok(metadata.code_challenge_methods_supported.includes('S256'));
  assert.equal(metadata.client_id_metadata_document_supported, true);
  assert.equal(metadata.authorization_response_iss_parameter_supported, true);
  const anonymous = await f.raw('tools/list', {}, { token: null });
  assert.equal(anonymous.status, 401); assert.ok(anonymous.headers.get('www-authenticate').includes('oauth-protected-resource/mcp'));
  const resourceMetadata = await (await f.edge.fetch(OWNER + '/.well-known/oauth-protected-resource/mcp')).json();
  assert.equal(resourceMetadata.resource, OWNER + '/mcp');
  for (const cimd of [false, true]) {
    const flow = await approve(f, await begin(f, { cimd }));
    const response = await callback(f, flow);
    assert.equal(response.status, 302, await response.text());
    const next = new URL(response.headers.get('location'));
    assert.equal(next.origin + next.pathname, redirectUri); assert.equal(next.searchParams.get('state'), 'chatgpt-client-state');
    assert.equal(next.searchParams.get('iss'), OWNER);
    const code = next.searchParams.get('code'); assert.ok(code);
    const issued = await exchange(f, flow, code); const tokens = await issued.json();
    assert.equal(issued.status, 200, JSON.stringify(tokens)); assert.ok(tokens.refresh_token);
    assert.equal(tokens.expires_in, 3600);
    assert.equal((await f.raw('tools/list', {}, { token: tokens.access_token })).status, 200);
    const githubCalls = f.requests.filter(u => u.includes('github.com')).length;
    const refreshed = await post(f, '/oauth/token', { grant_type: 'refresh_token', client_id: flow.clientId,
      resource: OWNER + '/mcp', refresh_token: tokens.refresh_token });
    const renewed = await refreshed.json(); assert.equal(refreshed.status, 200, JSON.stringify(renewed));
    assert.ok(renewed.refresh_token); assert.notEqual(renewed.refresh_token, tokens.refresh_token);
    assert.equal((await f.raw('tools/list', {}, { token: renewed.access_token })).status, 200);
    assert.equal(f.requests.filter(u => u.includes('github.com')).length, githubCalls);
    assert.equal((await exchange(f, flow, code)).status, 400);
    assert.equal((await callback(f, flow)).status, 400);
  }
  const logged = JSON.stringify(f.logs);
  for (const secret of ['TEST_GITHUB_SECRET', 'gho_valid', 'chatgpt-client-state']) assert.ok(!logged.includes(secret));
});

test('authorization rejects wrong owners, cross-browser state, unsafe clients and missing PKCE', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const flow = await begin(f, { clientName: '<script>PRIVATE_NAME</script>' });
  assert.ok(!flow.html.includes('<script>')); assert.ok(flow.html.includes('&#60;script&#62;'));
  const form = { handle: flow.handle, decision: 'approve', scope: 'magnt.owner.read' };
  assert.equal((await post(f, '/authorize', form, { origin: OWNER })).status, 400);
  assert.equal((await post(f, '/authorize', form, { origin: 'https://evil.example', cookie: flow.cookie })).status, 403);
  const approved = await approve(f, flow);
  assert.equal((await f.edge.fetch(OWNER + '/callback?code=valid&state=' + approved.state)).status, 400);
  const denied = await callback(f, approved, 'foreign');
  assert.equal(new URL(denied.headers.get('location')).searchParams.get('error'), 'access_denied');
  const before = f.requests.length;
  for (const redirect of ['https://evil.example/cb', 'https://chatgpt.com.evil.example/cb', redirectUri + '?next=evil']) {
    const url = new URL(flow.url); url.searchParams.set('redirect_uri', redirect);
    assert.equal((await f.edge.fetch(url)).status, 400);
  }
  const badClient = new URL(flow.url); badClient.searchParams.set('client_id', 'https://127.0.0.1/internal');
  assert.equal((await f.edge.fetch(badClient)).status, 400); assert.equal(f.requests.length, before);
  const noPkce = new URL(flow.url); noPkce.searchParams.delete('code_challenge');
  assert.equal((await f.edge.fetch(noPkce)).status, 400);
  const badToken = await post(f, '/oauth/token', { grant_type: 'refresh_token', client_id: 'https://evil.example/client.json', refresh_token: 'forged' });
  assert.equal(badToken.status, 400); assert.equal(f.requests.length, before);
  const registration = await f.edge.fetch(OWNER + '/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'ChatGPT', redirect_uris: ['https://evil.example/cb'], token_endpoint_auth_method: 'none' }) });
  assert.equal(registration.status, 400);
});

test('consent browser headers preserve Origin without relaxing CSRF or exposing OAuth queries', { timeout: 60000 }, async t => {
  const f = await fixture(t, { overrides: { OWNER_DCR_ENABLED: 'false' } });
  const flow = await begin(f, { cimd: true });
  const page = await f.edge.fetch(flow.url);
  assert.equal(page.headers.get('referrer-policy'), 'strict-origin');
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal(page.headers.get('content-security-policy'),
    `default-src 'none'; form-action 'self' https://github.com/login/oauth/authorize ${redirectUri}; frame-ancestors 'none'; base-uri 'none'`);
  const fields = { handle: flow.handle, decision: 'approve', scope: 'magnt.owner.read' };
  for (const origin of [undefined, 'null', 'https://evil.example', 'https://magnt.ru']) {
    const rejected = await post(f, '/authorize', fields, {
      cookie: flow.cookie, ...(origin === undefined ? {} : { origin }),
    });
    assert.equal(rejected.status, 403);
    assert.equal((await rejected.json()).code, 'invalid_origin');
    assert.equal(rejected.headers.get('referrer-policy'), 'no-referrer');
  }
  assert.equal((await post(f, '/authorize', fields, { origin: OWNER })).status, 400);
  const approved = await post(f, '/authorize', fields, { origin: OWNER, cookie: flow.cookie });
  assert.equal(approved.status, 302, await approved.text());
  assert.equal(new URL(approved.headers.get('location')).origin, 'https://github.com');
  assert.equal(approved.headers.get('referrer-policy'), 'no-referrer');
  for (const path of ['/mcp', '/.well-known/oauth-authorization-server']) {
    const response = await f.edge.fetch(OWNER + path);
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  }
  const cancel = await begin(f, { cimd: true });
  const denied = await post(f, '/authorize', { handle: cancel.handle, decision: 'deny' }, { origin: OWNER, cookie: cancel.cookie });
  assert.equal(denied.status, 302);
  const destination = new URL(denied.headers.get('location'));
  assert.equal(destination.origin + destination.pathname, redirectUri);
  assert.equal(destination.searchParams.get('error'), 'access_denied');
  assert.equal(denied.headers.get('referrer-policy'), 'no-referrer');
});

test('PKCE, audience, revocation, expiry and authorization epoch are enforced by the private core', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const flow = await approve(f, await begin(f));
  const returned = await callback(f, flow);
  const code = new URL(returned.headers.get('location')).searchParams.get('code');
  assert.equal((await exchange(f, flow, code, 'incorrect-verifier')).status, 400);
  assert.equal((await post(f, '/oauth/token', { grant_type: 'authorization_code', client_id: flow.clientId, code,
    code_verifier: flow.verifier, redirect_uri: redirectUri, resource: 'https://evil.example/mcp' })).status, 400);
  const revocation = await post(f, '/oauth/token', { client_id: f.credentials.client_id, token: f.credentials.refresh_token, token_type_hint: 'refresh_token' });
  assert.equal(revocation.status, 200, await revocation.text());
  assert.equal((await f.raw('tools/list')).status, 401);
  const oldEpoch = await f.mint({ epoch: 'retired' });
  const refresh = await post(f, '/oauth/token', { grant_type: 'refresh_token', client_id: oldEpoch.client_id, refresh_token: oldEpoch.refresh_token, resource: OWNER + '/mcp' });
  assert.equal(refresh.status, 400); assert.equal((await refresh.json()).error, 'invalid_grant');
  const short = await f.mint({ expired: true });
  assert.equal((await f.raw('tools/list', {}, { token: short.access_token })).status, 401);
  const readOnly = await f.mint({ scope: ['magnt.owner.read'] });
  const write = await f.raw('tools/call', { name: 'write_reply', arguments: {} }, { token: readOnly.access_token });
  assert.equal(write.status, 403); assert.ok(write.headers.get('www-authenticate').includes('magnt.owner.write'));
});

test('closed registration still permits ChatGPT metadata login and existing client refresh', { timeout: 60000 }, async t => {
  const f = await fixture(t, { overrides: { OWNER_DCR_ENABLED: 'false' } });
  const registration = await f.edge.fetch(OWNER + '/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [redirectUri], token_endpoint_auth_method: 'none' }) });
  assert.equal(registration.status, 403);
  const flow = await approve(f, await begin(f, { cimd: true }));
  const response = await callback(f, flow);
  const code = new URL(response.headers.get('location')).searchParams.get('code');
  assert.equal((await exchange(f, flow, code)).status, 200);
  const refreshed = await post(f, '/oauth/token', { grant_type: 'refresh_token', client_id: f.credentials.client_id,
    refresh_token: f.credentials.refresh_token, resource: OWNER + '/mcp' });
  assert.equal(refreshed.status, 200);
});

test('private core and public entrypoint cannot be used to bypass owner authorization', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  for (const path of ['/mcp', '/authorize', '/oauth/token', '/__admin']) assert.equal((await f.core.fetch(OWNER + path)).status, 404);
  assert.equal((await f.control.fetch('https://fixture.local/direct-owner')).status, 401);
  const publicCall = await f.raw('tools/call', { name: 'list_inbox', arguments: {} }, { public: true });
  assert.ok((await publicCall.json()).error);
  const forged = await f.raw('tools/list', {}, { token: null, headers: { 'Cf-Access-Jwt-Assertion': 'forged', 'X-Magnt-Owner': '1', 'X-Magnt-Role': 'owner' } });
  assert.equal(forged.status, 401);
  for (const path of ['/mcp-owner', '/authorize', '/callback', '/oauth/token', '/oauth/register']) {
    assert.equal((await f.raw('tools/list', {}, { public: true, path: path + '?code=PRIVATE_CALLBACK_CODE' })).status, 503);
  }
  assert.ok(!JSON.stringify(f.logs).includes('PRIVATE_CALLBACK_CODE'));
  await assert.rejects(() => f.mf.getD1Database('CONTACTS', 'public-edge'));
  await assert.rejects(() => f.mf.getD1Database('CONTACTS', 'owner-edge'));
});

test('read-only consent cannot add write or offline access and issues no refresh token', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const initial = await begin(f, { cimd: true, requestedScope: 'magnt.owner.read' });
  assert.ok(!initial.html.includes('value="magnt.owner.write"'));
  assert.ok(!initial.html.includes('value="offline_access"'));
  const flow = await approve(f, initial);
  const callbackResponse = await callback(f, flow);
  const code = new URL(callbackResponse.headers.get('location')).searchParams.get('code');
  const response = await exchange(f, flow, code);
  const tokens = await response.json();
  assert.equal(response.status, 200, JSON.stringify(tokens));
  assert.equal(tokens.scope, 'magnt.owner.read'); assert.ok(!tokens.refresh_token);
  assert.equal((await f.raw('tools/list', {}, { token: tokens.access_token })).status, 200);
  assert.equal((await f.raw('tools/call', { name: 'write_reply', arguments: {} }, { token: tokens.access_token })).status, 403);
});

test('gateway bounds methods, bodies, paths and request rates without logging credentials', { timeout: 60000 }, async t => {
  const f = await fixture(t, { gatewayLimit: 2 });
  assert.equal((await f.raw('tools/list')).status, 200);
  assert.equal((await f.raw('tools/list')).status, 200);
  const limited = await f.raw('tools/list'); assert.equal(limited.status, 429); assert.equal(limited.headers.get('retry-after'), '60');
  assert.equal((await f.edge.fetch(OWNER + '/mcp/anything')).status, 404);
  assert.equal((await f.edge.fetch(OWNER + '/mcp', { method: 'PUT' })).status, 405);
  assert.equal((await f.edge.fetch(OWNER + '/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'x'.repeat(25000) })).status, 413);
  assert.ok(!JSON.stringify(f.logs).includes(f.credentials.access_token));
});

test('deployment and dependency boundaries exclude storage and domain operations from gateways', async () => {
  const core = JSON.parse(await readFile('wrangler.core.jsonc', 'utf8'));
  assert.equal(core.workers_dev, false); assert.equal(core.preview_urls, false); assert.deepEqual(core.routes, []);
  assert.equal(core.main, 'src/core.js'); assert.equal(core.observability.logs.invocation_logs, false);
  for (const [config, entrypoint] of [['public', 'PublicApi'], ['owner', 'OwnerApi']]) {
    const cfg = JSON.parse(await readFile(`wrangler.${config}.jsonc`, 'utf8'));
    assert.equal(cfg.services.length, 1); assert.equal(cfg.services[0].entrypoint, entrypoint);
    assert.ok(!cfg.d1_databases); assert.ok(!cfg.kv_namespaces); assert.ok(!cfg.vars);
    const bundle = await build({ entryPoints: [cfg.main], bundle: true, write: false, format: 'esm', platform: 'browser',
      target: 'es2022', conditions: ['workerd', 'worker', 'browser'], external: ['node:*', 'cloudflare:*'], metafile: true });
    assert.ok(!bundle.outputFiles[0].text.includes('INSERT INTO'));
    for (const path of Object.keys(bundle.metafile.inputs)) {
      assert.ok(!/owner-workflow|owner-workspace|owner-oauth|owner-login|contacts\.js|task-signals\.js|telegram-notifications/.test(path), path);
    }
  }
});

test('public gateway preserves metrics and core Cron delivers the existing goal outbox', { timeout: 60000 }, async t => {
  const f = await fixture(t, { overrides: {
    CORE_NOTIFICATIONS_ENABLED: 'true', TELEGRAM_NOTIFICATIONS_ENABLED: 'true', TELEGRAM_GOAL_NOTIFICATIONS_ENABLED: 'true',
    TELEGRAM_BOT_TOKEN: '123456:FAKE_TOKEN_FOR_LOCAL_TESTS_ONLY_abcdef', TELEGRAM_OWNER_CHAT_ID: '123456789',
    NOTIFY_FROM: '2020-01-01T00:00:00.000Z',
  } });
  for (const controlled of [false, true]) {
    const response = await f.call('search_shared_experience', { goal: 'PRIVATE_CORE_GOAL' }, {
      public: true, headers: controlled ? { 'user-agent': 'MAGNT-Controlled-Test/0.2' } : {},
    });
    assert.equal(response.value.status, 'no_relevant_experience');
  }
  assert.equal(f.telegramMessages.length, 0);
  await f.pub.scheduled({ cron: '* * * * *', scheduledTime: Date.now() });
  assert.equal(f.telegramMessages.length, 0);
  await f.core.scheduled({ cron: '* * * * *', scheduledTime: Date.now() });
  assert.equal(f.telegramMessages.length, 1); assert.ok(f.telegramMessages[0].text.includes('PRIVATE_CORE_GOAL'));
  assert.equal((await f.db.prepare('SELECT status FROM owner_notification_outbox').first()).status, 'sent');
  await f.core.scheduled({ cron: '* * * * *', scheduledTime: Date.now() });
  assert.equal(f.telegramMessages.length, 1);
  const events = collectEvents(f.logs), metrics = summarizeEvents(events);
  assert.equal(events.size, 2); assert.equal(metrics.valid_search_calls, 1); assert.equal(metrics.excluded_test_events, 1);
  for (const event of events.values()) { assert.equal(event.status, 200); assert.ok(Number.isFinite(event.duration_ms)); }
  assert.ok(!JSON.stringify(f.logs).includes('PRIVATE_CORE_GOAL'));
  assert.ok(!JSON.stringify(f.logs).includes('FAKE_TOKEN_FOR_LOCAL_TESTS_ONLY'));
});
