import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { fixture, OWNER } from './support/owner-fixture.mjs';

const CALLBACK = 'http://127.0.0.1:19876/mcp/oauth/callback';
const FULL_SCOPE = 'magnt.owner.read magnt.owner.write offline_access';
function cookies(response, previous = '') {
  const jar = new Map(previous.split('; ').filter(Boolean).map(s => s.split('=')));
  for (const cookie of response.headers.getSetCookie()) {
    const [name, value] = cookie.split(';')[0].split('=');
    if (/max-age=0(?:;|$)/i.test(cookie)) jar.delete(name); else jar.set(name, value);
  }
  return [...jar].map(([name, value]) => name + '=' + value).join('; ');
}
const form = (f, route, fields, headers = {}) => f.edge.fetch(OWNER + route, {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
  body: new URLSearchParams(fields), redirect: 'manual',
});
async function registeredFixture(t) {
  const f = await fixture(t, { through: 8, overrides: { OWNER_LOCAL_CLIENT_SEED_ENABLED: 'true',
    OWNER_LOCAL_CLIENT_ENABLED: 'true' } });
  const response = await f.control.fetch('https://fixture.local/seed-local', { method: 'POST', body: '{}' });
  const client = await response.json();
  assert.equal(response.status, 200, JSON.stringify(client));
  assert.ok(client.clientId);
  assert.equal(client.redirectUri, CALLBACK);
  return { f, client };
}
async function begin(f, client, requestedScope = FULL_SCOPE, redirect = CALLBACK) {
  const verifier = 'p'.repeat(64);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const authorization = OWNER + '/authorize?' + new URLSearchParams({
    response_type: 'code', client_id: client.clientId, redirect_uri: redirect,
    resource: OWNER + '/mcp', scope: requestedScope, state: 'local-state',
    code_challenge: challenge, code_challenge_method: 'S256',
  });
  const page = await f.edge.fetch(authorization);
  return { page, html: await page.text(), verifier, client, redirect, requestedScope };
}
async function authorize(f, initial, selectedScopes = initial.requestedScope.split(' ')) {
  assert.equal(initial.page.status, 200, initial.html);
  const handle = initial.html.match(/name="handle" value="([^"]+)"/)?.[1];
  assert.ok(handle);
  const fields = new URLSearchParams({ handle, decision: 'approve' });
  selectedScopes.forEach(scope => fields.append('scope', scope));
  const approved = await form(f, '/authorize', fields, {
    origin: OWNER, cookie: cookies(initial.page),
  });
  assert.equal(approved.status, 302, await approved.text());
  const github = new URL(approved.headers.get('location'));
  assert.equal(github.origin, 'https://github.com');
  const complete = await f.edge.fetch(OWNER + '/callback?' + new URLSearchParams({
    state: github.searchParams.get('state'), code: 'valid',
  }), { headers: { cookie: cookies(approved, cookies(initial.page)) }, redirect: 'manual' });
  assert.equal(complete.status, 302, await complete.text());
  const localRedirect = new URL(complete.headers.get('location'));
  assert.equal(localRedirect.origin + localRedirect.pathname, CALLBACK);
  const issued = await form(f, '/oauth/token', {
    grant_type: 'authorization_code', client_id: initial.client.clientId, redirect_uri: initial.redirect,
    code: localRedirect.searchParams.get('code'), code_verifier: initial.verifier,
    resource: OWNER + '/mcp',
  });
  const credentials = await issued.json();
  assert.equal(issued.status, 200, JSON.stringify(credentials));
  return credentials;
}

test('pre-registered local owner receives all five existing tools and can revoke its own grant via primary owner', { timeout: 60000 }, async t => {
  const { f, client } = await registeredFixture(t);
  assert.match((await begin(f, client)).html, /90 суток/);
  const tokens = await authorize(f, await begin(f, client));
  assert.equal(tokens.expires_in, 3600);
  assert.ok(tokens.refresh_token);
  assert.ok(tokens.scope.includes('magnt.owner.write'));
  const response = await f.raw('tools/list', {}, { token: tokens.access_token });
  assert.equal(response.status, 200);
  const tools = (await response.json()).result.tools.map(tool => tool.name);
  for (const tool of ['list_inbox', 'read_conversation', 'write_reply', 'update_inbox', 'manage_dialogue_access'])
    assert.ok(tools.includes(tool), tool);
  assert.ok(!tools.includes('list_owner_grants'));
  assert.ok(!tools.includes('revoke_owner_grant'));
  assert.equal((await f.raw('tools/call', { name: 'write_reply', arguments: {} }, { token: tokens.access_token })).status, 200);
  const list = await f.call('list_owner_grants', {});
  assert.ok(list.value?.grants?.length, JSON.stringify(list.value));
  const grant = list.value.grants[0];
  assert.equal(grant.client_id, client.clientId);
  assert.ok(grant.expires_at - grant.issued_at <= 90 * 86400);
  const revoked = await f.call('revoke_owner_grant', { grant_id: grant.grant_id });
  assert.equal(revoked.value.status, 'revoked');
  assert.equal((await f.raw('tools/list', {}, { token: tokens.access_token })).status, 403);
  const refresh = await form(f, '/oauth/token', { grant_type: 'refresh_token',
    client_id: client.clientId, refresh_token: tokens.refresh_token, resource: OWNER + '/mcp' });
  assert.equal(refresh.status, 400);
  assert.equal((await f.raw('tools/list', {}, { token: f.credentials.access_token })).status, 200);
});

test('local consent respects explicit downgrade to read and rejects write', { timeout: 60000 }, async t => {
  const { f, client } = await registeredFixture(t);
  const issued = await authorize(f, await begin(f, client), ['magnt.owner.read']);
  assert.equal(issued.scope, 'magnt.owner.read');
  assert.ok(!issued.refresh_token);
  assert.equal((await f.raw('tools/list', {}, { token: issued.access_token })).status, 200);
  const attempt = await f.raw('tools/call', { name: 'write_reply', arguments: {} }, { token: issued.access_token });
  assert.equal(attempt.status, 403);
});

test('local registration and redirect fail closed', { timeout: 60000 }, async t => {
  const { f, client } = await registeredFixture(t);
  for (const redirect of [
    'http://localhost:19876/mcp/oauth/callback', 'http://127.0.0.1:80/mcp/oauth/callback',
    'http://127.0.0.1:19876/callback/another', 'http://127.0.0.1:19876/mcp/oauth/callback?x=y',
    'https://evil.example/callback',
  ]) assert.equal((await begin(f, client, FULL_SCOPE, redirect)).page.status, 400, redirect);
  const anon = await f.edge.fetch(OWNER + '/oauth/register', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'foreign',
      redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none' }) });
  assert.equal(anon.status, 403);
});

test('local grant absolute expiry blocks access without waiting for bearer expiry', { timeout: 60000 }, async t => {
  const { f, client } = await registeredFixture(t);
  const credentials = await authorize(f, await begin(f, client));
  await f.db.prepare('UPDATE owner_local_grants SET issued_at = 1, expires_at = 2').run();
  assert.equal((await f.raw('tools/list', {}, { token: credentials.access_token })).status, 403);
  const refreshed = await form(f, '/oauth/token', { grant_type: 'refresh_token',
    client_id: client.clientId, refresh_token: credentials.refresh_token, resource: OWNER + '/mcp' });
  assert.equal(refreshed.status, 400);
});
