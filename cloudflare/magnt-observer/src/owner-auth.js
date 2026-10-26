import { createRemoteJWKSet, jwtVerify } from 'jose';

const keySets = new Map();
export class OwnerAuthError extends Error {
  constructor(code, status) { super(code); this.code = code; this.status = status; }
}
export function ownerAuthConfiguration(env, { identityOnly = false } = {}) {
  if (!identityOnly && env.OWNER_MCP_ENABLED !== 'true') throw new OwnerAuthError('owner_disabled', 503);
  const issuer = env.OWNER_ACCESS_ISSUER;
  const audience = env.OWNER_ACCESS_AUD;
  const subject = env.OWNER_ACCESS_SUB;
  if (typeof issuer !== 'string' || !/^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.cloudflareaccess\.com$/.test(issuer)
      || typeof audience !== 'string' || !/^[a-zA-Z0-9_-]{16,128}$/.test(audience)
      || (!identityOnly && (typeof subject !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(subject)))) {
    throw new OwnerAuthError('owner_configuration_required', 503);
  }
  return { issuer, audience, subject, canWrite: env.OWNER_MCP_WRITE_ENABLED === 'true' };
}
export async function authenticateOwner(request, env, { identityOnly = false, keySet } = {}) {
  const config = ownerAuthConfiguration(env, { identityOnly });
  const assertion = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!assertion || assertion.length > 16384) throw new OwnerAuthError('unauthenticated', 401);
  // The issuer and JWKS origin come only from deployment configuration, never from token headers or claims.
  if (!keySet) {
    if (!keySets.has(config.issuer)) {
      if (keySets.size >= 4) keySets.clear();
      keySets.set(config.issuer, createRemoteJWKSet(new URL(config.issuer + '/cdn-cgi/access/certs'), {
        timeoutDuration: 5000, cooldownDuration: 30000, cacheMaxAge: 300000,
      }));
    }
    keySet = keySets.get(config.issuer);
  }
  let payload;
  try {
    ({ payload } = await jwtVerify(assertion, keySet, { issuer: config.issuer, audience: config.audience,
      algorithms: ['RS256'], requiredClaims: ['iss', 'aud', 'sub', 'exp', 'iat'] }));
  } catch { throw new OwnerAuthError('unauthenticated', 401); }
  if (typeof payload.sub !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(payload.sub)
      || payload.type !== 'app' || !Number.isFinite(payload.iat) || payload.iat > Date.now() / 1000 + 30) {
    throw new OwnerAuthError('unauthenticated', 401);
  }
  if (!identityOnly && payload.sub !== config.subject) throw new OwnerAuthError('forbidden', 403);
  return { verified: true, id: config.issuer + '|' + payload.sub, issuer: config.issuer,
    subject: payload.sub, canWrite: !identityOnly && config.canWrite };
}
