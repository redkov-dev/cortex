import { privateJson } from './owner-auth.js';
export async function callPublicCore(request, env) {
  if (!['/mcp', '/mcp/server-card', '/.well-known/mcp/server-card.json'].includes(new URL(request.url).pathname)) return null;
  if (!env.PUBLIC_CORE) return privateJson({ code: 'core_configuration_required' }, 503);
  const headers = new Headers(request.headers);
  for (const name of ['authorization', 'cookie', 'cf-access-jwt-assertion', 'x-magnt-owner', 'x-magnt-role']) headers.delete(name);
  return env.PUBLIC_CORE.fetch(new Request(request, { headers }));
}
