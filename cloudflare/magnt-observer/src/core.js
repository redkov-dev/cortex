import { WorkerEntrypoint } from 'cloudflare:workers';
import { handleMcp } from './mcp.js';
import { handleOwnerOAuth } from './owner-oauth.js';
import { boundOwnerRequest, protectOwnerResponse } from './owner-http.js';
import { privateJson } from './owner-auth.js';
import { processOwnerNotifications } from './owner-notifications.js';

// The default entrypoint is closed even if someone accidentally attaches an HTTP route.
export default class PrivateCore extends WorkerEntrypoint {
  fetch() { return privateJson({ code: 'not_found' }, 404); }
  async scheduled() {
    if (this.env.CORE_NOTIFICATIONS_ENABLED === 'true') await processOwnerNotifications(this.env);
  }
}
// Service bindings select a named entrypoint. Public callers cannot select OwnerApi by URL.
export class PublicApi extends WorkerEntrypoint {
  async fetch(request) {
    const started = Date.now();
    const url = new URL(request.url);
    if (!['magnt.ru', 'www.magnt.ru'].includes(url.hostname)
        || !['/mcp', '/mcp/server-card', '/.well-known/mcp/server-card.json'].includes(url.pathname)) {
      return privateJson({ code: 'not_found' }, 404);
    }
    const event = { event_type: 'mcp_request', time: new Date().toISOString(), event_id: crypto.randomUUID(),
      path: url.pathname, method: request.method,
      controlled_test: /^MAGNT-Controlled-Test(?:\/|$)/i.test(request.headers.get('user-agent') ?? '') };
    let response;
    try { response = await handleMcp(request, this.env, this.ctx, event); return response; }
    catch { response = privateJson({ code: 'storage_unavailable' }, 503); return response; }
    finally {
      event.status = response?.status ?? 503; event.duration_ms = Date.now() - started;
      event.outcome ??= event.status < 400 ? 'http_success' : 'http_error';
      console.log(JSON.stringify(event));
    }
  }
}
export class OwnerApi extends WorkerEntrypoint {
  async fetch(request) {
    try {
      const bounded = await boundOwnerRequest(request);
      if (bounded instanceof Response) return bounded;
      return protectOwnerResponse(await handleOwnerOAuth(bounded, this.env, this.ctx));
    } catch { return privateJson({ code: 'owner_unavailable' }, 503); }
  }
}
