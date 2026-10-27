import { OAuthAuthorizationServer, OAuthResourceServer, OAuthError, insufficientScope } from '@cloudflare/workers-oauth-provider';
import { ownerActor, ownerAuthConfiguration, OwnerAuthError, OWNER_ORIGIN, OWNER_RESOURCE,
  OWNER_READ_SCOPE, OWNER_WRITE_SCOPE, OWNER_SCOPES, isChatGptRedirect, isAllowedClientId, privateJson } from './owner-auth.js';
import { handleOwnerLogin } from './owner-login.js';
import { handleOwnerMcp } from './owner-mcp.js';

export const authorizationServer = new OAuthAuthorizationServer({
  issuer: OWNER_ORIGIN, resources: [OWNER_RESOURCE], defaultResource: OWNER_RESOURCE,
  authorizeEndpoint: '/authorize', tokenEndpoint: '/oauth/token', clientRegistrationEndpoint: '/oauth/register',
  scopesSupported: OWNER_SCOPES, clientIdMetadataDocumentEnabled: true,
  accessTokenTTL: 3600, refreshTokenTTL: 2592000, refreshTokenIdleTTL: 2592000, clientRegistrationTTL: undefined,
  allowTokenExchangeGrant: false,
  clientRegistrationCallback({ clientMetadata }) {
    if (!Array.isArray(clientMetadata.redirect_uris) || !clientMetadata.redirect_uris.length
        || clientMetadata.redirect_uris.length > 4 || !clientMetadata.redirect_uris.every(isChatGptRedirect)) {
      return { code: 'invalid_redirect_uri', description: 'Only ChatGPT callbacks are supported.' };
    }
  },
  tokenExchangeCallback({ env, props, userId, resource, scope }) {
    let config;
    try { config = ownerAuthConfiguration(env); }
    catch { throw new OAuthError('temporarily_unavailable', { description: 'Owner access is disabled.', statusCode: 503 }); }
    if (userId !== config.subject || props?.ownerId !== config.subject || props?.epoch !== config.epoch
        || resource !== OWNER_RESOURCE || !scope.includes(OWNER_READ_SCOPE)) {
      throw new OAuthError('invalid_grant', { description: 'Owner authorization was revoked.' });
    }
    return { refreshTokenTTL: scope.includes('offline_access') ? 2592000 : 0 };
  },
  onError: () => undefined, // Never log the library's internal error details or credentials.
});
const resourceServer = new OAuthResourceServer({
  resourceMetadata: { resource: OWNER_RESOURCE, authorization_servers: [OWNER_ORIGIN] }, requiredScopes: [OWNER_READ_SCOPE],
  validateToken: env => (resource, token) => authorizationServer.validateToken(resource, token, env),
  handler: { async fetch(request, env, ctx) {
    let actor;
    try { actor = ownerActor(env, ctx.auth, ctx.props); }
    catch (error) {
      if (error instanceof OwnerAuthError && error.code === 'insufficient_scope') return insufficientScope(ctx.auth, [OWNER_READ_SCOPE]);
      return privateJson({ code: error instanceof OwnerAuthError ? error.code : 'authentication_unavailable' }, error instanceof OwnerAuthError ? error.status : 503);
    }
    if (request.method === 'POST') {
      const body = await request.clone().json().catch(() => null);
      if (body?.method === 'tools/call' && ['write_reply', 'update_inbox'].includes(body.params?.name)
          && !ctx.auth.scope.includes(OWNER_WRITE_SCOPE)) return insufficientScope(ctx.auth, [OWNER_READ_SCOPE, OWNER_WRITE_SCOPE]);
    }
    const event = { event_type: 'owner_mcp_request', time: new Date().toISOString(), event_id: crypto.randomUUID() };
    try { return await handleOwnerMcp(request, env, ctx, event, actor); }
    finally { console.log(JSON.stringify(event)); }
  } },
});
export async function handleOwnerOAuth(request, env, ctx) {
  try { ownerAuthConfiguration(env); }
  catch (error) { return privateJson({ code: error.code ?? 'owner_configuration_required' }, error.status ?? 503); }
  const url = new URL(request.url);
  if (url.pathname === '/oauth/register' && env.OWNER_DCR_ENABLED !== 'true') return privateJson({ error: 'registration_disabled' }, 403);
  if (url.pathname === '/authorize' || url.pathname === '/callback') return handleOwnerLogin(request, env, authorizationServer.getOAuthApi(env));
  if (url.pathname === '/oauth/token' && request.method === 'POST') {
    const body = await request.clone().text();
    let fields;
    try { fields = request.headers.get('content-type')?.includes('application/json') ? JSON.parse(body) : Object.fromEntries(new URLSearchParams(body)); }
    catch { return privateJson({ error: 'invalid_request' }, 400); }
    // Require explicit identity before any client-metadata lookup, including private_key_jwt.
    let clientId = fields?.client_id;
    try {
      if (!clientId && request.headers.get('authorization')?.startsWith('Basic ')) {
        clientId = decodeURIComponent(atob(request.headers.get('authorization').slice(6)).split(':')[0]);
      }
      if (!clientId && typeof fields?.client_assertion === 'string') {
        const part = fields.client_assertion.split('.')[1];
        clientId = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/'))).iss;
      }
    } catch { return privateJson({ error: 'invalid_client' }, 400); }
    if (!isAllowedClientId(clientId)) return privateJson({ error: 'invalid_client' }, 400);
  }
  if (url.pathname === '/mcp' || url.pathname === '/.well-known/oauth-protected-resource/mcp'
      || url.pathname === '/.well-known/oauth-protected-resource') return resourceServer.fetch(request, env, ctx);
  return authorizationServer.fetch(request, env, ctx);
}
