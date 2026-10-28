import { AuthorizationError, authorizationErrorRedirect } from '@cloudflare/workers-oauth-provider';
import { OWNER_ORIGIN, OWNER_RESOURCE, OWNER_SCOPES, isChatGptRedirect, isAllowedClientId, privateJson } from './owner-auth.js';
import { readBody } from './mcp-transport.js';

const escapeHtml = value => String(value).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const base64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const challenge = async value => base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));

function allowedRequest(request) {
  return isAllowedClientId(request.clientId) && isChatGptRedirect(request.redirectUri)
    && request.resource === OWNER_RESOURCE && request.codeChallengeMethod === 'S256'
    && typeof request.codeChallenge === 'string'
    && request.scope.includes('magnt.owner.read') && request.scope.every(scope => OWNER_SCOPES.includes(scope));
}
function consentHtml(details, handle, scopes) {
  return `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Подключение MAGNT Owner</title><body><main><h1>Подключить MAGNT Owner</h1>
<p>Приложение: <strong>${escapeHtml(details.clientName)}</strong>.</p>
<p>Возврат после входа: <strong>${escapeHtml(details.redirectHost)}</strong>.</p>
<p>${details.clientDomain ? 'Домен приложения: ' + escapeHtml(details.clientDomain) : 'Название приложения заявлено при регистрации.'}</p>
<p>Доступ получит только настроенный владелец MAGNT. На следующем шаге подтвердите его аккаунтом GitHub.</p>
<form method="post" action="/authorize"><input type="hidden" name="handle" value="${escapeHtml(handle)}">
<p><label><input type="checkbox" name="scope" value="magnt.owner.read" checked required> Читать частные обращения и цели</label></p>
${scopes.includes('magnt.owner.write') ? '<p><label><input type="checkbox" name="scope" value="magnt.owner.write" checked> Сохранять черновики и управлять входящими по моей команде</label></p>' : ''}
${scopes.includes('offline_access') ? '<p><label><input type="checkbox" name="scope" value="offline_access" checked> Сохранять подключение с автоматическим обновлением доступа</label></p>' : ''}
<p>Черновики не отправляются посетителям. Подключение истекает после 30 дней без обновления; его можно отозвать.</p>
<button name="decision" value="approve">Продолжить через GitHub</button>
<button name="decision" value="deny" formnovalidate>Отмена</button></form></main></body></html>`;
}
async function upstreamJson(url, init) {
  const response = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error('upstream_unavailable');
  const body = await readBody(response);
  if (!body) throw new Error('upstream_unavailable');
  return JSON.parse(new TextDecoder().decode(body));
}
async function githubIdentity(code, verifier, env) {
  if (!code || code.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(code)) throw new Error('invalid_code');
  const token = await upstreamJson('https://github.com/login/oauth/access_token', {
    method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.OWNER_GITHUB_CLIENT_ID, client_secret: env.OWNER_GITHUB_CLIENT_SECRET,
      code, code_verifier: verifier, redirect_uri: OWNER_ORIGIN + '/callback' }).toString(),
  });
  if (typeof token.access_token !== 'string' || token.access_token.length > 2048 || /[\r\n]/.test(token.access_token)) throw new Error('invalid_token');
  const user = await upstreamJson('https://api.github.com/user', { headers: {
    authorization: `Bearer ${token.access_token}`, accept: 'application/vnd.github+json', 'user-agent': 'MAGNT-Owner-Login/1.0',
    'X-GitHub-Api-Version': '2022-11-28',
  } });
  // GitHub proves identity once; its tokens are neither stored nor accepted as MCP credentials.
  return Number.isSafeInteger(user.id) && user.id > 0 && user.type === 'User' ? String(user.id) : null;
}
function redirect(headers, location) {
  headers.set('location', location);
  return new Response(null, { status: 302, headers });
}
export async function handleOwnerLogin(request, env, oauth) {
  const url = new URL(request.url);
  if (!env.OWNER_GITHUB_CLIENT_ID || !env.OWNER_GITHUB_CLIENT_SECRET) return privateJson({ code: 'owner_configuration_required' }, 503);
  try {
    if (url.pathname === '/authorize' && request.method === 'GET') {
      if (!isAllowedClientId(url.searchParams.get('client_id')) || !isChatGptRedirect(url.searchParams.get('redirect_uri'))) {
        return privateJson({ code: 'invalid_client' }, 400);
      }
      const parsed = await oauth.parseAuthRequest(request);
      if (!allowedRequest(parsed)) return privateJson({ code: 'invalid_authorization_request' }, 400);
      const details = await oauth.describeConsent(parsed);
      const consent = await oauth.beginConsent(parsed);
      consent.headers.set('content-type', 'text/html; charset=utf-8');
      // Chromium checks form-action on redirects too: approval goes to GitHub,
      // cancellation to the ChatGPT callback already validated by allowedRequest.
      consent.headers.set('content-security-policy', `default-src 'none'; form-action 'self' https://github.com/login/oauth/authorize ${parsed.redirectUri}; frame-ancestors 'none'; base-uri 'none'`);
      return new Response(consentHtml(details, consent.handle, parsed.scope), { headers: consent.headers });
    }
    if (url.pathname === '/authorize' && request.method === 'POST') {
      if (request.headers.get('origin') !== OWNER_ORIGIN) return privateJson({ code: 'invalid_origin' }, 403);
      const form = await request.formData();
      const handle = String(form.get('handle') ?? '');
      if (form.get('decision') !== 'approve') {
        const denied = await oauth.denyConsent(request, handle);
        return new Response(null, { status: 302, headers: denied.headers });
      }
      const scope = form.getAll('scope').map(String);
      if (!scope.includes('magnt.owner.read') || scope.some(s => !OWNER_SCOPES.includes(s))) return privateJson({ code: 'invalid_scope' }, 400);
      const approved = await oauth.approveConsent(request, handle, { scope });
      if (!allowedRequest(approved.request)) return privateJson({ code: 'invalid_authorization_request' }, 400);
      const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
      const { state, headers } = await oauth.beginUpstream(approved.request, { data: { verifier }, headers: approved.headers });
      const next = new URL('https://github.com/login/oauth/authorize');
      next.search = new URLSearchParams({ client_id: env.OWNER_GITHUB_CLIENT_ID, redirect_uri: OWNER_ORIGIN + '/callback',
        state, code_challenge: await challenge(verifier), code_challenge_method: 'S256' }).toString();
      return redirect(headers, next.href);
    }
    if (url.pathname === '/callback' && request.method === 'GET') {
      const { request: original, data, headers } = await oauth.finishUpstream(request);
      if (!allowedRequest(original)) return privateJson({ code: 'invalid_authorization_request' }, 400);
      if (url.searchParams.has('error')) return redirect(headers, authorizationErrorRedirect(original, 'access_denied'));
      const ownerId = await githubIdentity(url.searchParams.get('code'), data.verifier, env);
      if (ownerId !== env.OWNER_GITHUB_ID) return redirect(headers, authorizationErrorRedirect(original, 'access_denied'));
      const { redirectTo } = await oauth.completeAuthorization({ request: original, userId: ownerId, metadata: {},
        scope: original.scope, props: { ownerId, epoch: env.OWNER_AUTH_EPOCH } });
      return redirect(headers, redirectTo);
    }
    return privateJson({ code: 'not_found' }, 404);
  } catch (error) {
    return privateJson({ code: error instanceof AuthorizationError ? 'authorization_request_expired_or_invalid' : 'authentication_unavailable' },
      error instanceof AuthorizationError ? 400 : 503);
  }
}
