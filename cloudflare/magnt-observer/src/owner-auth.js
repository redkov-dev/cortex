export const OWNER_ORIGIN = 'https://owner.magnt.ru';
export const OWNER_RESOURCE = OWNER_ORIGIN + '/mcp';
export const OWNER_READ_SCOPE = 'magnt.owner.read';
export const OWNER_WRITE_SCOPE = 'magnt.owner.write';
export const OWNER_SCOPES = [OWNER_READ_SCOPE, OWNER_WRITE_SCOPE, 'offline_access'];

export class OwnerAuthError extends Error {
  constructor(code, status) { super(code); this.code = code; this.status = status; }
}
export function ownerAuthConfiguration(env) {
  if (env.OWNER_MCP_ENABLED !== 'true') throw new OwnerAuthError('owner_disabled', 503);
  if (!/^[1-9][0-9]{0,19}$/.test(env.OWNER_GITHUB_ID ?? '')
      || !/^[a-zA-Z0-9_-]{1,64}$/.test(env.OWNER_AUTH_EPOCH ?? '') || !env.OAUTH_KV) {
    throw new OwnerAuthError('owner_configuration_required', 503);
  }
  return { subject: env.OWNER_GITHUB_ID, epoch: env.OWNER_AUTH_EPOCH,
    canWrite: env.OWNER_MCP_WRITE_ENABLED === 'true' };
}
// auth and props are produced only by the OAuth resource adapter after validation.
export function ownerActor(env, auth, props) {
  const config = ownerAuthConfiguration(env);
  if (!auth || auth.audience !== OWNER_RESOURCE || auth.userId !== config.subject
      || props?.ownerId !== config.subject || props?.epoch !== config.epoch) {
    throw new OwnerAuthError('forbidden', 403);
  }
  if (!auth.scope?.includes(OWNER_READ_SCOPE)) throw new OwnerAuthError('insufficient_scope', 403);
  return { verified: true, id: 'github|' + config.subject, subject: config.subject,
    canWrite: config.canWrite && auth.scope.includes(OWNER_WRITE_SCOPE) };
}
export function isChatGptRedirect(value) {
  return typeof value === 'string' && value.length <= 512
    && /^https:\/\/chatgpt\.com\/(?:connector_platform_oauth_redirect|connector\/oauth\/[A-Za-z0-9_-]+)$/.test(value);
}
export function isAllowedClientId(value) {
  if (typeof value !== 'string' || value.length > 512) return false;
  if (value.startsWith('https://')) return /^https:\/\/chatgpt\.com\/oauth\/(?:[A-Za-z0-9_-]+\/)?client\.json$/.test(value);
  return /^[A-Za-z0-9_-]{1,200}$/.test(value);
}
export function privateJson(value, status = 200, extraHeaders = {}) {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store',
    'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', ...extraHeaders } });
}
export function isOwnerPrivatePath(pathname) {
  let path;
  try { path = decodeURIComponent(pathname).toLowerCase(); } catch { path = pathname.toLowerCase(); }
  return /^\/(?:mcp-owner(?:\/|$)|owner(?:\/|$)|(?:authorize|callback)(?:\/|$)|oauth\/(?:token|register)(?:\/|$)|\.well-known\/(?:oauth-|openid-)|cdn-cgi\/access(?:\/|$))/.test(path);
}
