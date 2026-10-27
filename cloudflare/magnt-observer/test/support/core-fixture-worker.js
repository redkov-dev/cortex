// Local-only grant issuer for adversarial test credentials. Never a deployment entrypoint.
import { WorkerEntrypoint } from 'cloudflare:workers';
import { OAuthAuthorizationServer } from '@cloudflare/workers-oauth-provider';
import { OWNER_ORIGIN, OWNER_RESOURCE, OWNER_SCOPES } from '../../src/owner-auth.js';
export { default, PublicApi, OwnerApi } from '../../src/core.js';
export class TestControl extends WorkerEntrypoint {
  async fetch(request) {
    const options = await request.json();
    const issuer = new OAuthAuthorizationServer({ issuer: OWNER_ORIGIN, resources: [OWNER_RESOURCE],
      scopesSupported: OWNER_SCOPES, accessTokenTTL: options.ttl ?? 900, onError: () => undefined });
    const api = issuer.getOAuthApi(this.env);
    if (options.revoke) {
      const [user, grant] = options.revoke.split(':');
      await api.revokeGrant(grant, user);
      return Response.json({ revoked: true });
    }
    const client = await api.createClient({ clientName: 'Local integration fixture',
      redirectUris: ['https://chatgpt.com/connector_platform_oauth_redirect'], tokenEndpointAuthMethod: 'none',
      grantTypes: ['authorization_code', 'refresh_token'], responseTypes: ['code'] });
    const verifier = 'v'.repeat(64);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    const codeChallenge = btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const scope = options.scope ?? OWNER_SCOPES;
    const { redirectTo } = await api.completeAuthorization({
      request: { responseType: 'code', clientId: client.clientId, redirectUri: client.redirectUris[0],
        resource: OWNER_RESOURCE, issuer: OWNER_ORIGIN, scope, state: 'test', codeChallenge, codeChallengeMethod: 'S256' },
      userId: options.userId ?? '1', metadata: {}, scope, props: { ownerId: options.userId ?? '1', epoch: options.epoch ?? '1' },
    });
    const response = await issuer.fetch(new Request(OWNER_ORIGIN + '/oauth/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: client.clientId,
        redirect_uri: client.redirectUris[0], resource: OWNER_RESOURCE, code_verifier: verifier, code: new URL(redirectTo).searchParams.get('code') }),
    }), this.env, this.ctx);
    const tokens = await response.json();
    if (options.expired && response.ok) {
      // Exercise real validation of an expired stored token without waiting a minute.
      const [user, grant] = tokens.access_token.split(':');
      const records = await this.env.OAUTH_KV.list({ prefix: `token:${user}:${grant}:` });
      for (const { name } of records.keys) {
        const data = await this.env.OAUTH_KV.get(name, 'json');
        data.expiresAt = Math.floor(Date.now() / 1000) - 60;
        await this.env.OAUTH_KV.put(name, JSON.stringify(data));
      }
    }
    return Response.json({ ...tokens, client_id: client.clientId }, { status: response.status });
  }
}
