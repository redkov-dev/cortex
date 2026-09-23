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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cf = request.cf || {};
    const ua = request.headers.get("user-agent") || "";
    const referrer = request.headers.get("referer") || "";
    const client = classifyClient(ua);

    const event = {
      time: new Date().toISOString(),
      method: request.method,
      host: url.hostname,
      path: url.pathname,
      query: url.search,
      userAgent: ua,
      clientKind: client.kind,
      clientName: client.name,
      referrer,
      country: cf.country || "",
      city: cf.city || "",
      asn: cf.asn || null,
      colo: cf.colo || "",
    };

    console.log(JSON.stringify(event));

    if (url.pathname === "/__magnt_probe") {
      return new Response(JSON.stringify({
        ok: true,
        service: "magnt-observer",
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

    if (env.ANALYTICS) {
      env.ANALYTICS.writeDataPoint({
        blobs: [
          url.pathname,
          request.method,
          client.kind,
          client.name,
          ua.slice(0, 1000),
          referrer.slice(0, 1000),
          cf.country || "",
          cf.city || "",
          String(cf.asn || ""),
          cf.colo || "",
        ],
        doubles: [1],
        indexes: [url.hostname],
      });
    }

    return fetch(request);
  },
};
