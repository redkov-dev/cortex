# MAGNT Observer

Status: MVP operational as of 2026-09-23.

## Purpose

MAGNT Observer is a server-side visit counter for https://magnt.ru.

Its purpose is to see HTTP clients that touch the MAGNT site, including clients
that do not execute browser JavaScript: crawlers, scanners, bots, AI agents,
command-line clients and ordinary browsers.

This is intentionally different from browser analytics such as Google Analytics.

## Architecture

```
Internet client
      |
      v
Cloudflare authoritative DNS
      |
      v
Cloudflare proxied edge
      |
      v
Worker Route: magnt.ru/*
      |
      v
magnt-observer Cloudflare Worker
      |      | \--> Workers Observability / Logs
      |
      v
fetch(request)
      |
      v
GitHub Pages
      |
      v
redkov-dev/cortex
```

GitHub Pages remains the origin hosting the static MAGNT site.
Cloudflare sits in front of it and executes `magnt-observer` for requests matching
`magnt.ru/*`.

The site's GitHub Pages custom domain is `magnt.ru` (repository `CNAME` file).

## Deployment

Source repository: `redkov-dev/cortex`

Worker source:
- `cloudflare/magnt-observer/src/index.js`
- `cloudflare/magnt-observer/wrangler.jsonc`

Cloudflare build root:
`cloudflare/magnt-observer`

Deploy command:
`npx wrangler deploy`

Production Worker:
`magnt-observer`

Production route:
`magnt.ru/*`

The Worker is deployed from GitHub through Cloudflare Builds. Commits to the
configured branch can trigger a new deployment.

## What the Worker records

For every request, the Worker emits a JSON event to Workers Logs containing:

- timestamp
- HTTP method
- host
- path
- query string
- User-Agent
- referrer
- simple client classification
- country
- city
- ASN
- Cloudflare colo

The simple client classifier currently recognizes several explicit User-Agent
strings, including GPTBot, ChatGPT-User, OAI-SearchBot, ClaudeBot,
PerplexityBot, Googlebot, Bingbot, YandexBot, curl, wget and common Python HTTP
clients.

The classifier is heuristic. A bot that pretends to be a browser can still be
classified as `browser-or-unknown`. Cloudflare's own event metadata can be used
for additional analysis.

## Probe endpoint

`https://magnt.ru/__magnt_probe`

This path is answered directly by the Worker and is used to verify that the
production route is active.

A successful response contains:

```json
{
  "ok": true,
  "service": "magnt-observer"
}
```

If this endpoint responds, the request reached `magnt-observer` rather than
going directly to GitHub Pages.

## MVP acceptance criteria

The MVP is considered working because:

1. `magnt.ru` is served through Cloudflare.
2. The Worker route `magnt.ru/*` is active.
3. `/__magnt_probe` is answered by the Worker.
4. Worker invocations accumulate in Cloudflare Observability.
5. Logs can be exported and contain real machine traffic to the site.
6. HTTP clients are observed even when they execute no JavaScript.

Therefore the original MVP goal — a counter that can see both human browser
traffic and robots — is achieved.

## Current limitations

- An invocation is an HTTP request, not a unique visitor.
- One visitor or robot may generate many requests.
- The current classifier primarily uses User-Agent and does not reliably detect
  bots that impersonate browsers.
- Long-term aggregated analytics is not enabled yet.
- Analytics Engine support exists in the Worker code behind the optional
  `ANALYTICS` binding, but the binding is currently not configured.
- There is no dashboard yet for unique clients, bot categories or visits to
  high-value MAGNT endpoints such as `/llms.txt` and `/agents.md`.

These are post-MVP improvements rather than requirements for the visit-counter
MVP.
