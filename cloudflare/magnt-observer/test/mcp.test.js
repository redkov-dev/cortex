import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { Miniflare } from "miniflare";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { Client as LegacyClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport as LegacyTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const endpoint = "https://magnt.ru/mcp";
const logs = [];

async function runtime(withStorage = true) {
  const modules = {};
  for (const name of (await readdir("dist")).filter((n) => n.endsWith(".js") || n.endsWith(".sql"))) {
    modules[name] = { type: name.endsWith(".sql") ? "text" : "esm", contents: await readFile(`dist/${name}`, "utf8") };
  }
  return new Miniflare({
    cf: false,
    logRequests: false,
    telemetry: { enabled: false },
    handleStructuredLogs: (entry) => logs.push(entry),
    workers: [{
      config: {
        name: "magnt-test",
        compatibilityDate: "2026-09-23",
        compatibilityFlags: ["nodejs_compat"],
        manifest: { mainModule: "index.js", modules },
        env: withStorage ? { CONTACTS: { type: "d1", id: crypto.randomUUID() } } : {},
      },
      dev: { outboundService: { type: "fetcher", handler: async (request) => {
        assert.equal(new URL(request.url).hostname, "raw.githubusercontent.com");
        return new Response(request.method === "HEAD" ? null : "origin fixture", { status: 200 });
      } } },
    }],
  });
}

function rawModern(method, params = {}) {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": method };
  if (method === "tools/call") headers["Mcp-Name"] = params.name;
  if (method === "resources/read") headers["Mcp-Name"] = params.uri;
  return {
    method: "POST", headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 100, method, params: { ...params, _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { name: "magnt-direct-test", version: "0.1.0" },
      "io.modelcontextprotocol/clientCapabilities": {},
    } } }),
  };
}

test("MCP Door uses real SDKs and durable D1 receipts", { timeout: 60000 }, async (t) => {
  const mf = await runtime();
  const client = new Client({ name: "magnt-modern-test", version: "0.1.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), { fetch: (url, init) => mf.dispatchFetch(String(url), init) });
  let receipt;
  try {
    await client.connect(transport);
    const db = await mf.getD1Database("CONTACTS");
    await t.test("modern discovery, tool listing and profile resource", async () => {
      const tools = await client.listTools();
      assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ["about_magnt", "propose_contact"]);
      assert.deepEqual(tools.tools.find((tool) => tool.name === "propose_contact").inputSchema.required, ["summary"]);
      assert.equal((await client.listResources()).resources[0].uri, "magnt://profile");
      const resource = await client.readResource({ uri: "magnt://profile" });
      const about = await client.callTool({ name: "about_magnt", arguments: {} });
      assert.deepEqual(JSON.parse(resource.contents[0].text), about.structuredContent);
      assert.equal(about.structuredContent.contact.storage_available, true);
    });

    await t.test("concurrent retries persist one message and return the same receipt", async () => {
      const input = { summary: "PRIVATE_CONTENT_SENTINEL: Let's explore continuity together.", reply_to: "private-reply@example.test", is_test: true, submission_id: crypto.randomUUID() };
      const results = await Promise.all([1, 2].map(() => client.callTool({ name: "propose_contact", arguments: input })));
      for (const result of results) assert.notEqual(result.isError, true);
      receipt = results[0].structuredContent;
      assert.equal(receipt.status, "accepted_for_human_review");
      assert.equal(receipt.contact_id, results[1].structuredContent.contact_id);
      assert.equal(results.filter((result) => result.structuredContent.duplicate).length, 1);
      const row = await db.prepare("SELECT * FROM contacts WHERE contact_id = ?").bind(receipt.contact_id).first();
      assert.equal(row.summary, input.summary);
      assert.equal(row.reply_to, input.reply_to);
      assert.equal(row.review_status, "pending");
      assert.equal(row.self_reported_test, 1);
      assert.equal(row.protocol_version, "2026-07-28");
      const conflict = await client.callTool({ name: "propose_contact", arguments: { ...input, summary: "Different content" } });
      assert.equal(conflict.isError, true);
      assert.equal(conflict.structuredContent.status, "submission_conflict");
      assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM contacts").first()).count, 1);
    });

    await t.test("legacy SDK initializes, lists capabilities and saves a follow-up", async () => {
      const legacy = new LegacyClient({ name: "magnt-legacy-test", version: "0.1.0" });
      try {
        await legacy.connect(new LegacyTransport(new URL(endpoint), { fetch: (url, init) => mf.dispatchFetch(String(url), init) }));
        assert.equal((await legacy.listTools()).tools.length, 2);
        assert.equal((await legacy.listResources()).resources.length, 1);
        const result = await legacy.callTool({ name: "propose_contact", arguments: { summary: "A legacy follow-up", previous_contact_id: receipt.contact_id, is_test: true } });
        assert.notEqual(result.isError, true);
        const row = await db.prepare("SELECT * FROM contacts WHERE contact_id = ?").bind(result.structuredContent.contact_id).first();
        assert.equal(row.previous_contact_id, receipt.contact_id);
      } finally { await legacy.close(); }
    });

    await t.test("a modern client can call a tool without an earlier handshake", async () => {
      const r = await mf.dispatchFetch(endpoint, rawModern("tools/call", { name: "about_magnt", arguments: {} }));
      assert.equal(r.status, 200);
      assert.equal((await r.json()).result.structuredContent.name, "MAGNT");
    });

    await t.test("invalid fields, oversized requests and untrusted browser origins are rejected", async () => {
      const invalid = await client.callTool({ name: "propose_contact", arguments: { summary: " " } });
      assert.equal(invalid.isError, true);
      const tooLong = await client.callTool({ name: "propose_contact", arguments: { summary: "x".repeat(4001) } });
      assert.equal(tooLong.isError, true);
      const huge = await mf.dispatchFetch(endpoint, { method: "POST", body: "x".repeat(25 * 1024) });
      assert.equal(huge.status, 413);
      const options = rawModern("tools/list");
      options.headers.Origin = "https://untrusted.example";
      assert.equal((await mf.dispatchFetch(endpoint, options)).status, 403);
      const malformed = await mf.dispatchFetch(endpoint, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{" });
      assert.equal(malformed.status, 400);
      assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM contacts").first()).count, 2);
    });

    await t.test("server-card alias and existing static routing work", async () => {
      const card = await mf.dispatchFetch("https://magnt.ru/mcp/server-card");
      assert.match(card.headers.get("content-type"), /application\/mcp-server-card\+json/);
      assert.deepEqual(await card.json(), await (await mf.dispatchFetch("https://magnt.ru/.well-known/mcp/server-card.json")).json());
      assert.equal((await mf.dispatchFetch("https://magnt.ru/mcp/server-card", { method: "HEAD" })).status, 200);
      assert.equal(await (await mf.dispatchFetch("https://magnt.ru/")).text(), "origin fixture");
      assert.equal((await mf.dispatchFetch("https://magnt.ru/", { method: "POST", body: "{}" })).status, 405);
    });

    await t.test("missing storage never returns an accepted receipt", async () => {
      const empty = await runtime(false);
      try {
        const r = await empty.dispatchFetch(endpoint, rawModern("tools/call", { name: "propose_contact", arguments: { summary: "Message without storage" } }));
        const result = (await r.json()).result;
        assert.equal(result.isError, true);
        assert.equal(result.structuredContent.status, "not_saved");
        assert.equal(result.structuredContent.contact_id, undefined);
      } finally { await empty.dispose(); }
    });

    await t.test("telemetry records outcomes but excludes message text and reply addresses", async () => {
      const serialized = JSON.stringify(logs);
      assert.ok(serialized.includes("accepted_for_human_review"));
      assert.ok(serialized.includes("propose_contact"));
      assert.ok(serialized.includes(receipt.contact_id));
      assert.ok(!serialized.includes("PRIVATE_CONTENT_SENTINEL"));
      assert.ok(!serialized.includes("private-reply@example.test"));
    });
  } finally {
    await client.close();
    await mf.dispose();
  }
});
