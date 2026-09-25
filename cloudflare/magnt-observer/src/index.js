import { handleMcp } from "./mcp.js";

function classifyClient(ua = "") {
  const s = ua.toLowerCase();

  const known = [
    ["gptbot", "GPTBot"],
    ["chatgpt-user", "ChatGPT-User"],
    ["oai-searchbot", "OAI-SearchBot"],
    ["claudebot", "ClaudeBot"],
    ["claude-web", "Claude-Web"],
    ["anthropic-ai", "Anthropic"],
    ["perplexitybot", "PerplexityBot"],
    ["googlebot", "Googlebot"],
    ["bingbot", "Bingbot"],
    ["yandexbot", "YandexBot"],
    ["duckduckbot", "DuckDuckBot"],
    ["bytespider", "ByteSpider"],
    ["facebookexternalhit", "Facebook"],
    ["twitterbot", "Twitterbot"],
    ["linkedinbot", "LinkedInBot"],
    ["curl/", "curl"],
    ["wget/", "wget"],
    ["python-requests", "python-requests"],
    ["python-httpx", "python-httpx"],
  ];

  for (const [needle, name] of known) {
    if (s.includes(needle)) return { kind: "bot", name };
  }

  if (/bot|crawler|spider|scraper|headless|httpclient|aiohttp|okhttp|go-http-client/.test(s)) {
    return { kind: "probable-bot", name: "unidentified" };
  }

  return { kind: "browser-or-unknown", name: "unknown" };
}

function contentTypeFor(pathname) {
  if (pathname === "/" || pathname.endsWith(".html")) return "text/html; charset=utf-8";
  if (pathname.endsWith(".css")) return "text/css; charset=utf-8";
  if (pathname.endsWith(".js") || pathname.endsWith(".mjs")) return "text/javascript; charset=utf-8";
  if (pathname.endsWith(".json")) return "application/json; charset=utf-8";
  if (pathname.endsWith(".txt")) return "text/plain; charset=utf-8";
  if (pathname.endsWith(".md")) return "text/markdown; charset=utf-8";
  if (pathname.endsWith(".xml")) return "application/xml; charset=utf-8";
  if (pathname.endsWith(".svg")) return "image/svg+xml";
  if (pathname.endsWith(".png")) return "image/png";
  if (pathname.endsWith(".jpg") || pathname.endsWith(".jpeg")) return "image/jpeg";
  if (pathname.endsWith(".webp")) return "image/webp";
  if (pathname.endsWith(".ico")) return "image/x-icon";
  return null;
}

function githubRawUrl(pathname) {
  let path = pathname;
  if (path === "/") path = "/index.html";
  if (path.endsWith("/")) path += "index.html";

  let decoded;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return null;
  }

  if (decoded.includes("..")) return null;

  return "https://raw.githubusercontent.com/redkov-dev/cortex/main" + path;
}

export default {
  async fetch(request, env, ctx) {
    const started = Date.now();
    const url = new URL(request.url);
    const cf = request.cf || {};
    const ua = (request.headers.get("user-agent") || "").slice(0, 1000);
    const isMcp = url.pathname === "/mcp" || url.pathname.startsWith("/mcp/") || url.pathname === "/.well-known/mcp/server-card.json";
    const referrer = isMcp ? "" : (request.headers.get("referer") || "").slice(0, 1000);
    const client = classifyClient(ua);

    const event = {
      time: new Date().toISOString(),
      event_id: crypto.randomUUID(),
      method: request.method,
      host: url.hostname,
      path: url.pathname,
      query: isMcp ? "" : url.search,
      userAgent: ua,
      clientKind: client.kind,
      clientName: client.name,
      referrer,
      country: cf.country || "",
      city: cf.city || "",
      asn: cf.asn || null,
      colo: cf.colo || "",
    };

    let response;
    try {
      response = await routeRequest(request, env, ctx, event, url);
      return response;
    } catch {
      event.outcome = "internal_error";
      response = new Response("Service temporarily unavailable", { status: 503 });
      return response;
    } finally {
      event.status = response?.status ?? 503;
      event.duration_ms = Date.now() - started;
      event.outcome ??= event.status < 400 ? "http_success" : "http_error";
      console.log(JSON.stringify(event));
      if (env.ANALYTICS) {
        try {
          env.ANALYTICS.writeDataPoint({
            blobs: [url.pathname, request.method, client.kind, client.name, ua, referrer, cf.country || "", cf.city || "", String(cf.asn || ""), cf.colo || ""],
            doubles: [1],
            indexes: [url.hostname],
          });
        } catch { /* Optional analytics must not interrupt contact delivery. */ }
      }
    }
  },
};

async function routeRequest(request, env, ctx, event, url) {
  const mcpResponse = await handleMcp(request, env, ctx, event);
  if (mcpResponse) return mcpResponse;

  if (url.pathname === "/__magnt_probe") {
    return new Response(JSON.stringify({
      ok: true,
      service: "magnt-observer",
      mcp_door_version: "0.1.0",
      contact_storage_configured: Boolean(env.CONTACTS),
      origin: "raw.githubusercontent.com/redkov-dev/cortex/main",
      time: event.time,
      host: event.host,
      path: event.path,
      clientKind: event.clientKind,
      clientName: event.clientName,
      country: event.country,
      colo: event.colo
    }, null, 2), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-magnt-observer": "1"
      }
    });
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { "allow": "GET, HEAD" }
    });
  }

  const originUrl = githubRawUrl(url.pathname);
  if (!originUrl) {
    return new Response("Bad Request", { status: 400 });
  }

  const originResponse = await fetch(originUrl, {
    method: request.method,
    headers: {
      "user-agent": "MAGNT-Origin-Fetch/1.0",
      "accept": request.headers.get("accept") || "*/*"
    },
    cf: {
      cacheEverything: true,
      cacheTtl: 60
    }
  });

  const headers = new Headers(originResponse.headers);
  headers.delete("content-disposition");
  headers.delete("x-content-type-options");

  const contentType = contentTypeFor(url.pathname);
  if (contentType) headers.set("content-type", contentType);

  headers.set("x-magnt-observer", "1");
  headers.set("x-magnt-origin", "github-raw");

  return new Response(originResponse.body, {
    status: originResponse.status,
    statusText: originResponse.statusText,
    headers
  });
}
