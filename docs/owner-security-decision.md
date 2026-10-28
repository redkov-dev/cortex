# MAGNT Owner B.1: security boundary without a paid service

Decision, 27 October 2026. This supersedes the Access Managed OAuth choice in B.
Alexander requires persistent ChatGPT access, protection of the private workspace,
and no additional infrastructure subscription or Zero Trust billing setup.
Migration 0006 has already been applied by Alexander. Preserve it and all data.

## Boundary

Keep the domain modules and one existing D1 database in a private `magnt-core`
Worker. It has no public fetch service, custom domain, route, workers.dev or preview
URL. Only the core has D1, Telegram credentials and OAuth storage. Named Service
Binding entrypoints expose a public MCP adapter and an owner adapter separately.
Neither entrypoint exposes generic SQL, a generic proxy or arbitrary operation
dispatch. The owner adapter verifies authorization inside this private boundary.

`magnt-observer` remains the public site gateway. After cutover it has only the
public core binding; remove its D1 binding and notification secrets. A separate
`magnt-owner-gateway` on `owner.magnt.ru` has only the owner core binding and rate
limit bindings. Separate origins also isolate owner login cookies from site code.
It checks canonical URLs, methods, sizes and rates before forwarding. The old
`magnt.ru/mcp-owner` remains closed. This isolation requirement justifies splitting
deployment units under AR-01; business logic remains a modular monolith.

## Authorization

Use the pinned official `@cloudflare/workers-oauth-provider` implementation for
OAuth 2.1, PKCE, browser-bound consent and upstream state, token hashing/encryption,
refresh rotation, audience validation and revocation. GitHub authenticates the
owner at linking, pinned by immutable numeric ID. No MAGNT password or repository
access is required. GitHub credentials are never MCP credentials.

ChatGPT receives one-hour MAGNT access tokens and renewable refresh tokens.
Refresh is local to MAGNT and does not send the user to GitHub. Grants expire after
30 days of inactivity. Each request and refresh checks the configured owner and a
server-controlled authorization epoch. Changing that epoch invalidates existing
grants; disabling Owner closes tools immediately after deployment propagation.
GitHub app revocation prevents new logins; existing MAGNT grants are revoked in
MAGNT, independently. Only ChatGPT metadata origins and callback URLs are allowed.
CIMD is the default; dynamic registration is closed unless temporarily enabled
for a legacy client. No public signup, client-supplied identity or caller-supplied
privileges.

### Browser consent correction, 29 October 2026

Keep the exact owner-origin check on consent POSTs and the library's browser-bound
consent handle/cookie. A form document must use `Referrer-Policy: strict-origin`:
`no-referrer` makes browsers send `Origin: null` on navigation POSTs, so the old
blanket response policy rejected the legitimate form. `strict-origin` preserves
the origin while excluding the authorization path and query from referrers.
Other responses retain `no-referrer`. Alongside `'self'`, allow only the fixed
GitHub authorization destination and the validated ChatGPT cancellation callback
in `form-action`, since Chromium checks form redirects too.
Verify actual browser submission through the gateway and core,
including the redirect to GitHub, after deployment.

## Limits and activation

Use only Workers/KV/D1 free allowances and existing GitHub. Edge WAF/DDoS protection
and application rate limits complement authentication; neither is a guarantee of
availability under quota exhaustion. Rate counters are approximate per location.
Free CPU usage must be measured in production before acceptance, not inferred from
local wall time. Do not enable a paid plan or overage billing.

Ship a staged transition so the existing public MCP and Telegram keep working
while Alexander creates the private core, owner gateway and bindings manually.
The transition is not reported as isolated until the old public D1 binding and
secrets are removed and public/owner acceptance checks pass. No Cloudflare account
access by the assistant. No destructive migrations. Rollback preserves histories.
