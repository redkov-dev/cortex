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
async function registeredFixture(t, extraOverrides = {}) {
  const f = await fixture(t, { through: 8, overrides: { OWNER_LOCAL_CLIENT_SEED_ENABLED: 'true',
    OWNER_LOCAL_CLIENT_ENABLED: 'true', OWNER_DCR_ENABLED: 'false',
    DIALOGUE_CREATE_ENABLED: 'true', DIALOGUE_READ_ENABLED: 'true', DIALOGUE_WRITE_ENABLED: 'true', ...extraOverrides } });
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
  // Even a full local write scope does not authorize OAuth grant management.
  assert.equal((await f.raw('tools/call', { name: 'list_owner_grants', arguments: {} }, { token: tokens.access_token })).status, 403);
  const primary = await f.mint({ ownerClientClass: 'chatgpt' });
  const list = await f.call('list_owner_grants', {}, { token: primary.access_token });
  assert.ok(list.value?.grants?.length, JSON.stringify(list.value));
  const grant = list.value.grants[0];
  assert.equal(grant.client_id, client.clientId);
  assert.ok(grant.expires_at - grant.issued_at <= 90 * 86400);
  const revoked = await f.call('revoke_owner_grant', { grant_id: grant.grant_id }, { token: primary.access_token });
  assert.equal(revoked.value.status, 'revoked');
  assert.equal((await f.raw('tools/list', {}, { token: tokens.access_token })).status, 403);
  const refresh = await form(f, '/oauth/token', { grant_type: 'refresh_token',
    client_id: client.clientId, refresh_token: tokens.refresh_token, resource: OWNER + '/mcp' });
  assert.equal(refresh.status, 400);
  assert.equal((await f.raw('tools/list', {}, { token: primary.access_token })).status, 200);
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

test('rotating refresh rejects the old token and respects 90-day absolute grant time', { timeout: 60000 }, async t => {
  const { f, client } = await registeredFixture(t);
  const start = await authorize(f, await begin(f, client));
  const first = await form(f, '/oauth/token', { grant_type: 'refresh_token',
    client_id: client.clientId, refresh_token: start.refresh_token, resource: OWNER + '/mcp' });
  const rotated = await first.json();
  assert.equal(first.status, 200, JSON.stringify(rotated));
  assert.ok(rotated.refresh_token);
  assert.notEqual(rotated.refresh_token, start.refresh_token);
  assert.equal((await f.raw('tools/list', {}, { token: rotated.access_token })).status, 200);
  // The Cloudflare provider intentionally permits the immediately previous refresh
  // token for lost-response recovery; after consuming the current token, the one
  // preceding that grace window must be rejected.
  const next = await form(f, '/oauth/token', { grant_type: 'refresh_token',
    client_id: client.clientId, refresh_token: rotated.refresh_token, resource: OWNER + '/mcp' });
  assert.equal(next.status, 200, await next.text());
  const old = await form(f, '/oauth/token', { grant_type: 'refresh_token',
    client_id: client.clientId, refresh_token: start.refresh_token, resource: OWNER + '/mcp' });
  assert.equal(old.status, 400);
  // Renewal must not silently renew server-side absolute expiry.
  const record = await f.db.prepare('SELECT issued_at, expires_at FROM owner_local_grants').first();
  assert.equal(record.expires_at - record.issued_at, 90 * 86400);
});

test('two independent local grants allow revoking one without affecting the other', { timeout: 60000 }, async t => {
  const { f, client } = await registeredFixture(t);
  const a = await authorize(f, await begin(f, client));
  const b = await authorize(f, await begin(f, client));
  const primary = await f.mint({ ownerClientClass: 'chatgpt' });
  const first = await f.call('list_owner_grants', {}, { token: primary.access_token });
  assert.equal(first.value.grants.length, 2);
  const id = first.value.grants[0].grant_id;
  await f.call('revoke_owner_grant', { grant_id: id }, { token: primary.access_token });
  const results = await Promise.all([a,b].map(tkn => f.raw('tools/list', {}, { token: tkn.access_token })));
  assert.deepEqual(results.map(x=>x.status).sort(), [200,403]);
  assert.equal((await f.raw('tools/list', {}, { token: primary.access_token })).status, 200);
});

test('disabled C.1 cannot leak OAuth grant management tools into local listings', { timeout: 60000 }, async t => {
  const { f, client } = await registeredFixture(t, {
    DIALOGUE_CREATE_ENABLED: 'false', DIALOGUE_READ_ENABLED: 'false', DIALOGUE_WRITE_ENABLED: 'false',
  });
  const local = await authorize(f, await begin(f, client));
  const primary = await f.mint({ ownerClientClass: 'chatgpt' });
  const trusted = await f.raw('tools/list', {}, { token: primary.access_token });
  assert.equal(trusted.status, 200);
  assert.ok((await trusted.json()).result.tools.some(x => x.name === 'revoke_owner_grant'));
  const localList = await f.raw('tools/list', {}, { token: local.access_token });
  assert.equal(localList.status, 200);
  const names = (await localList.json()).result.tools.map(x => x.name);
  assert.deepEqual(names.sort(), ['list_inbox','read_conversation','update_inbox','write_reply'].sort());
  assert.equal((await f.raw('tools/call', { name: 'revoke_owner_grant',
    arguments: { grant_id: crypto.randomUUID() } }, { token: local.access_token })).status, 403);
});

test('resource and PKCE are mandatory for local authorization', { timeout: 60000 }, async t => {
  const { f, client } = await registeredFixture(t);
  const base = OWNER + '/authorize?' + new URLSearchParams({
    response_type: 'code', client_id: client.clientId, redirect_uri: CALLBACK,
    scope: FULL_SCOPE, state: 's', code_challenge: createHash('sha256').update('p'.repeat(64)).digest('base64url'),
    code_challenge_method: 'S256', resource: OWNER + '/mcp',
  });
  const bad = [
    { resource: null },
    { resource: 'https://magnt.ru/mcp' },
    { code_challenge_method: null },
    { client_id: 'wrong-client-id' },
  ];
  for(const obj of bad){
    const u = new URL(base);
    for(const [k,val] of Object.entries(obj)) if(val===null)u.searchParams.delete(k);else u.searchParams.set(k,val);
    const response = await f.edge.fetch(u);
    assert.equal(response.status, 400, u.searchParams.toString());
  }
  const tokens = await authorize(f, await begin(f, client));
  const badRefresh = await form(f,'/oauth/token', {grant_type:'refresh_token',
    client_id:client.clientId,refresh_token:tokens.refresh_token,resource:'https://magnt.ru/mcp'});
  assert.equal(badRefresh.status, 400);
});
