import { boundOwnerRequest, protectOwnerResponse, OWNER_PATHS } from './owner-http.js';
import { privateJson } from './owner-auth.js';

async function permitted(request, env) {
  if (!env.OWNER_CORE || !env.OWNER_REQUEST_LIMIT || !env.OWNER_LOGIN_LIMIT) return false;
  // Cloudflare sets this edge header. It is used only for coarse abuse limiting, never identity.
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
  if (!(await env.OWNER_REQUEST_LIMIT.limit({ key: 'source:' + ip })).success) return false;
  const path = new URL(request.url).pathname;
  if (['/authorize', '/callback', '/oauth/register'].includes(path)) {
    if (!(await env.OWNER_LOGIN_LIMIT.limit({ key: 'source:' + ip })).success) return false;
    if (!(await env.OWNER_REQUEST_LIMIT.limit({ key: 'login-total' })).success) return false;
  }
  return true;
}
export default {
  async fetch(request, env) {
    const started = Date.now();
    const path = new URL(request.url).pathname;
    let response;
    try {
      const bounded = await boundOwnerRequest(request);
      if (bounded instanceof Response) response = bounded;
      else if (!env.OWNER_CORE || !env.OWNER_REQUEST_LIMIT || !env.OWNER_LOGIN_LIMIT) response = privateJson({ code: 'gateway_configuration_required' }, 503);
      else if (!await permitted(request, env)) response = privateJson({ code: 'rate_limited' }, 429, { 'retry-after': '60' });
      else response = await env.OWNER_CORE.fetch(bounded);
    } catch { response = privateJson({ code: 'owner_unavailable' }, 503); }
    console.log(JSON.stringify({ event_type: 'owner_gateway', path: OWNER_PATHS.has(path) ? path : 'unknown',
      status: response.status, duration_ms: Date.now() - started }));
    return protectOwnerResponse(response);
  },
};
