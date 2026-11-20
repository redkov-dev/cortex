import { OWNER_RESOURCE, OWNER_READ_SCOPE, OWNER_WRITE_SCOPE, OwnerAuthError } from './owner-auth.js';

// This record is metadata, not a bearer token or credential. The OAuth library owns its client record.
const CLIENT_RECORD = 'owner:local-client:registration:v1';
export const LOCAL_CALLBACK = 'http://127.0.0.1:19876/mcp/oauth/callback';
const MAX_GRANT_SECONDS = 90 * 24 * 60 * 60;
const nowSeconds = () => Math.floor(Date.now() / 1000);

// Pilot intentionally registers one literal callback, not an unrestricted loopback wildcard.
export function isLocalLoopbackRedirect(uri) {
  return uri === LOCAL_CALLBACK;
}
export async function registeredLocalClient(env) {
  if (env.OWNER_LOCAL_CLIENT_ENABLED !== 'true' || !env.OAUTH_KV) return null;
  const saved = await env.OAUTH_KV.get(CLIENT_RECORD, 'json');
  return saved && typeof saved.clientId === 'string' && saved.redirectUri === LOCAL_CALLBACK ? saved : null;
}
export async function isRegisteredLocalClient(env, clientId, redirectUri) {
  if (!isLocalLoopbackRedirect(redirectUri)) return false;
  const saved = await registeredLocalClient(env);
  return Boolean(saved && saved.clientId === clientId);
}

// Run only from the private core's existing Cron with a one-shot owner-controlled flag.
// The resulting public client ID is retrieved from the private OAUTH_KV record by the owner.
export async function seedOwnerLocalClient(env, oauthApi) {
  if (env.OWNER_LOCAL_CLIENT_SEED_ENABLED !== 'true' || env.OWNER_MCP_ENABLED !== 'true'
      || !env.OAUTH_KV || !env.CONTACTS) return null;
  const existing = await env.OAUTH_KV.get(CLIENT_RECORD, 'json');
  if (existing?.clientId) return existing;
  const client = await oauthApi.createClient({
    clientName: 'MAGNT Owner local desktop', redirectUris: [LOCAL_CALLBACK],
    tokenEndpointAuthMethod: 'none', grantTypes: ['authorization_code', 'refresh_token'],
    responseTypes: ['code'],
  });
  const record = { clientId: client.clientId, redirectUri: LOCAL_CALLBACK, createdAt: new Date().toISOString() };
  await env.OAUTH_KV.put(CLIENT_RECORD, JSON.stringify(record));
  return record;
}

export async function issueLocalGrant(env, request, ownerId, scope) {
  const registered = await isRegisteredLocalClient(env, request.clientId, request.redirectUri);
  if (!registered || !env.CONTACTS) throw new OwnerAuthError('forbidden', 403);
  const issuedAt = nowSeconds(), expiresAt = issuedAt + MAX_GRANT_SECONDS;
  const grantId = crypto.randomUUID();
  await env.CONTACTS.prepare(
    'INSERT INTO owner_local_grants (grant_id, owner_subject, client_id, scope, resource, epoch, issued_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(grantId, ownerId, request.clientId, JSON.stringify(scope), OWNER_RESOURCE,
    env.OWNER_AUTH_EPOCH, issuedAt, expiresAt).run();
  return grantId;
}

export async function verifyLocalGrant(env, props, ownerId, epoch, tokenScope) {
  if (props?.ownerClientClass !== 'local' || !props.localGrantId || !props.localClientId
      || !env.CONTACTS) throw new OwnerAuthError('forbidden', 403);
  const saved = await registeredLocalClient(env);
  if (!saved || saved.clientId !== props.localClientId) throw new OwnerAuthError('forbidden', 403);
  const grant = await env.CONTACTS.prepare(
    'SELECT grant_id, owner_subject, client_id, scope, resource, epoch, expires_at, revoked_at FROM owner_local_grants WHERE grant_id = ?'
  ).bind(props.localGrantId).first();
  if (!grant || grant.owner_subject !== ownerId || grant.client_id !== saved.clientId
      || grant.epoch !== epoch || grant.resource !== OWNER_RESOURCE
      || grant.revoked_at !== null || grant.expires_at <= nowSeconds()) throw new OwnerAuthError('forbidden', 403);
  let granted;
  try { granted = JSON.parse(grant.scope); } catch { throw new OwnerAuthError('forbidden', 403); }
  if (!Array.isArray(granted) || !Array.isArray(tokenScope)
      || !tokenScope.includes(OWNER_READ_SCOPE) || !tokenScope.every(s => granted.includes(s))
      || (tokenScope.includes(OWNER_WRITE_SCOPE) && !granted.includes(OWNER_WRITE_SCOPE))) {
    throw new OwnerAuthError('forbidden', 403);
  }
  return grant;
}

export async function listLocalGrants(env) {
  if (!env.CONTACTS) throw new OwnerAuthError('forbidden', 403);
  const result = await env.CONTACTS.prepare(
    'SELECT grant_id, client_id, scope, issued_at, expires_at, revoked_at FROM owner_local_grants ORDER BY issued_at DESC, grant_id DESC LIMIT 50'
  ).all();
  const registeredClient = await env.OAUTH_KV?.get(CLIENT_RECORD, 'json');
  return { status: 'ok', local_client: registeredClient?.clientId
    ? { client_id: registeredClient.clientId, redirect_uri: LOCAL_CALLBACK } : null,
    grants: result.results ?? [] };
}
export async function revokeLocalGrant(env, grantId) {
  if (!env.CONTACTS) throw new OwnerAuthError('forbidden', 403);
  const existing = await env.CONTACTS.prepare('SELECT grant_id, revoked_at FROM owner_local_grants WHERE grant_id = ?')
    .bind(grantId).first();
  if (!existing) return { status: 'not_found', grant_id: grantId };
  if (existing.revoked_at === null) await env.CONTACTS.prepare(
    'UPDATE owner_local_grants SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL'
  ).bind(nowSeconds(), grantId).run();
  return { status: 'revoked', grant_id: grantId };
}
