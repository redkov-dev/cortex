import { OWNER_ORIGIN, privateJson } from './owner-auth.js';
import { readBody } from './mcp-transport.js';

export const OWNER_PATHS = new Map([
  ['/mcp', ['GET', 'POST', 'DELETE']],
  ['/authorize', ['GET', 'POST']], ['/callback', ['GET']],
  ['/oauth/token', ['POST']], ['/oauth/register', ['POST']],
  ['/.well-known/oauth-authorization-server', ['GET']],
  ['/.well-known/openid-configuration', ['GET']],
  ['/.well-known/oauth-protected-resource', ['GET']],
  ['/.well-known/oauth-protected-resource/mcp', ['GET']],
]);
export async function boundOwnerRequest(request) {
  const url = new URL(request.url);
  const methods = OWNER_PATHS.get(url.pathname);
  if (url.origin !== OWNER_ORIGIN || !methods || (request.headers.has('host') && request.headers.get('host') !== 'owner.magnt.ru')) {
    return privateJson({ code: 'not_found' }, 404);
  }
  if (request.url.length > 8192 || (request.headers.get('authorization')?.length ?? 0) > 16384
      || (request.headers.get('cookie')?.length ?? 0) > 16384) return privateJson({ code: 'request_too_large' }, 413);
  if (!methods.includes(request.method)) return privateJson({ code: 'method_not_allowed' }, 405, { allow: methods.join(', ') });
  const origin = request.headers.get('origin');
  if (origin && origin !== OWNER_ORIGIN) return privateJson({ code: 'invalid_origin' }, 403);
  if (request.method === 'POST') {
    const type = request.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    const accepted = url.pathname === '/mcp' || url.pathname === '/oauth/register'
      ? ['application/json'] : ['application/x-www-form-urlencoded', 'application/json'];
    if (!accepted.includes(type)) return privateJson({ code: 'unsupported_media_type' }, 415);
    const bytes = await readBody(request);
    if (bytes === null) return privateJson({ code: 'body_too_large' }, 413);
    return new Request(request, { body: bytes });
  }
  return request;
}
export function protectOwnerResponse(response) {
  const headers = new Headers(response.headers);
  headers.set('cache-control', 'no-store'); headers.set('referrer-policy', 'no-referrer');
  headers.set('x-content-type-options', 'nosniff'); headers.set('x-frame-options', 'DENY');
  return new Response(response.body, { status: response.status, headers });
}
