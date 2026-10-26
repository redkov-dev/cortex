import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { Miniflare } from "miniflare";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { Client as LegacyClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport as LegacyTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { runSmoke } from "../scripts/smoke.mjs";

const endpoint = "https://magnt.ru/mcp";
const logs = [];
const toolNames = ["about_magnt", "contribute_task_signal", "propose_contact", "search_shared_experience"];

async function migrateTaskSignals(db) {
  for (const file of ["migrations/0002_task_signals.sql", "migrations/0003_observed_task_signals.sql"]) {
    const sql = await readFile(file, "utf8");
    for (const statement of sql.split(";").filter((s) => s.trim())) await db.prepare(statement).run();
  }
}

async function readRpc(response) {
  const body = await response.text();
  return JSON.parse(response.headers.get("content-type")?.includes("text/event-stream")
    ? body.split("\n").find((line) => line.startsWith("data: ")).slice(6) : body);
}

function observerEvents(value, result = []) {
  if (typeof value === "string") {
    try { observerEvents(JSON.parse(value), result); } catch { /* SDK messages are not Observer JSON. */ }
  } else if (value && typeof value === "object") {
    if (value.event_type === "mcp_request") result.push(value);
    else for (const entry of Object.values(value)) observerEvents(entry, result);
  }
  return result;
}

async function runtime(withStorage = true) {
  const modules = {};
  for (const name of (await readdir(process.env.MAGNT_TEST_BUNDLE ?? "dist")).filter((n) => n.endsWith(".js") || n.endsWith(".sql"))) {
    modules[name] = { type: name.endsWith(".sql") ? "text" : "esm", contents: await readFile(`${process.env.MAGNT_TEST_BUNDLE ?? "dist"}/${name}`, "utf8") };
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
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: { headers: { "user-agent": "MAGNT-Controlled-Test/0.2" } },
    fetch: (url, init) => mf.dispatchFetch(String(url), init),
  });
  let receipt;
  try {
    await client.connect(transport);
    const db = await mf.getD1Database("CONTACTS");
    await migrateTaskSignals(db);
    await t.test("modern discovery, tool listing and profile resource", async () => {
      const tools = await client.listTools();
      assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), toolNames);
      assert.deepEqual(tools.tools.find((tool) => tool.name === "search_shared_experience").annotations,
        { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
      assert.equal(tools.tools.find((tool) => tool.name === "contribute_task_signal").annotations.readOnlyHint, false);
      for (const name of ["search_shared_experience", "contribute_task_signal"]) {
        assert.deepEqual(tools.tools.find((tool) => tool.name === name).inputSchema.required, ["goal"]);
      }
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
        assert.equal((await legacy.listTools()).tools.length, 4);
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

    await t.test("empty search stores a private observed task but no shared signal", async () => {
      const input = { goal: "QUERY_GOAL_SENTINEL calendar scheduling", blocker: "QUERY_BLOCKER_SENTINEL calendar collision", tried: "QUERY_TRIED_SENTINEL rescheduling", is_test: true };
      const result = await client.callTool({ name: "search_shared_experience", arguments: input });
      assert.notEqual(result.isError, true);
      assert.equal(result.structuredContent.status, "no_relevant_experience");
      assert.equal(result.structuredContent.matches_found, 0);
      assert.equal(result.structuredContent.contribution_tool, "contribute_task_signal");
      assert.match(result.structuredContent.search_receipt, /^sr_/);
      assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM task_signals").first()).n, 0);
      assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM observed_task_signals").first()).n, 1);
      const row = await db.prepare("SELECT * FROM observed_task_signals").first();
      assert.equal(row.goal, input.goal);
      assert.equal(row.blocker, input.blocker);
      assert.equal(row.tried, input.tried);
      assert.equal(row.self_reported_test, 1);
      for (const key of ["ip", "country", "asn", "userAgent", "email", "client_name", "agent_identity", "operator", "contact_id", "event_id", "search_receipt"]) {
        assert.equal(row[key], undefined);
      }
    });

    await t.test("ordinary searches retain separate private observations without making them searchable", async () => {
      const goal = "ORDINARY_OBSERVATION_SENTINEL unique observation demand";
      for (let attempt = 0; attempt < 2; attempt++) {
        const rpc = await readRpc(await mf.dispatchFetch(endpoint,
          rawModern("tools/call", { name: "search_shared_experience", arguments: { goal } })));
        assert.notEqual(rpc.result.isError, true);
        assert.equal(rpc.result.structuredContent.status, "no_relevant_experience");
      }
      const rows = (await db.prepare("SELECT * FROM observed_task_signals WHERE goal = ?").bind(goal).all()).results;
      assert.equal(rows.length, 2);
      assert.notEqual(rows[0].observation_id, rows[1].observation_id);
      for (const row of rows) {
        assert.equal(row.self_reported_test, 0);
        assert.equal(row.blocker, null);
        assert.equal(row.tried, null);
      }
      assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM task_signals").first()).n, 0);
    });

    let publicSignal, testSignal, searchReceipt;
    const task = {
      goal: "TASK_GOAL_SENTINEL durable Cloudflare D1 database migration",
      blocker: "TASK_BLOCKER_SENTINEL database migration permissions",
      tried: "TASK_TRIED_SENTINEL check Cloudflare database binding",
      learned: "TASK_LEARNED_SENTINEL Check permissions before migration. Unverified visitor observation.",
      submission_id: crypto.randomUUID(),
    };
    await t.test("concurrent contributions persist once, preserve retries, and reject conflicting content", async () => {
      const before = await client.callTool({ name: "search_shared_experience", arguments: { goal: task.goal } });
      searchReceipt = before.structuredContent.search_receipt;
      const input = { ...task, search_receipt: searchReceipt };
      const results = await Promise.all([1, 2].map(() => client.callTool({ name: "contribute_task_signal", arguments: input })));
      for (const result of results) assert.notEqual(result.isError, true);
      assert.deepEqual(results.map((r) => r.structuredContent.status).sort(), ["accepted", "duplicate"]);
      publicSignal = results[0].structuredContent.signal_id;
      assert.equal(publicSignal, results[1].structuredContent.signal_id);
      const row = await db.prepare("SELECT * FROM task_signals WHERE signal_id = ?").bind(publicSignal).first();
      for (const key of ["goal", "blocker", "tried", "learned"]) assert.equal(row[key], task[key]);
      assert.equal(row.self_reported_test, 0);
      assert.equal(row.status, "active");
      assert.equal(row.search_receipt, undefined);
      for (const key of ["ip", "country", "asn", "userAgent", "email", "client_name", "agent_identity", "operator"]) assert.equal(row[key], undefined);
      const conflict = await client.callTool({ name: "contribute_task_signal", arguments: { ...input, learned: "Changed observation" } });
      assert.equal(conflict.isError, true);
      assert.equal(conflict.structuredContent.status, "submission_conflict");
      assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM task_signals").first()).n, 1);
    });

    await t.test("subsequent search exposes only shared fields and separates test records", async () => {
      const saved = await client.callTool({ name: "contribute_task_signal", arguments: { ...task, submission_id: crypto.randomUUID(), is_test: true } });
      testSignal = saved.structuredContent.signal_id;
      assert.equal(saved.structuredContent.self_reported_test, true);
      assert.equal((await db.prepare("SELECT self_reported_test FROM task_signals WHERE signal_id = ?").bind(testSignal).first()).self_reported_test, 1);
      for (const is_test of [false, true]) {
        const result = await client.callTool({ name: "search_shared_experience", arguments: { goal: task.goal, is_test } });
        assert.notEqual(result.isError, true);
        assert.equal(result.structuredContent.status, "matches_found");
        assert.equal(result.structuredContent.matches_found, 1);
        assert.equal(result.structuredContent.content_trust, "unverified_visitor_content");
        const match = result.structuredContent.matches[0];
        assert.equal(match.signal_id, is_test ? testSignal : publicSignal);
        assert.deepEqual(Object.keys(match).sort(), ["blocker", "goal", "learned", "signal_id", "tried"]);
        assert.equal(match.learned, task.learned);
      }
    });

    await t.test("controlled ordinary-corpus searches retain only test observations", async () => {
      const ordinaryCount = (await db.prepare("SELECT COUNT(*) AS n FROM observed_task_signals WHERE self_reported_test = 0").first()).n;
      const testCount = (await db.prepare("SELECT COUNT(*) AS n FROM observed_task_signals WHERE self_reported_test = 1").first()).n;
      const request = rawModern("tools/call", { name: "search_shared_experience", arguments: { goal: task.goal, is_test: false } });
      request.headers["user-agent"] = "MAGNT-Controlled-Test/0.2";
      const result = (await readRpc(await mf.dispatchFetch(endpoint, request))).result;
      assert.notEqual(result.isError, true);
      assert.deepEqual(result.structuredContent.matches.map((match) => match.signal_id), [publicSignal]);
      assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM observed_task_signals WHERE self_reported_test = 0").first()).n, ordinaryCount);
      assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM observed_task_signals WHERE self_reported_test = 1").first()).n, testCount + 1);
    });

    await t.test("hidden records are excluded and retries do not reactivate them", async () => {
      await db.prepare("UPDATE task_signals SET status = 'hidden' WHERE signal_id = ?").bind(publicSignal).run();
      const retry = await client.callTool({ name: "contribute_task_signal", arguments: task });
      assert.equal(retry.structuredContent.status, "duplicate");
      const result = await client.callTool({ name: "search_shared_experience", arguments: { goal: task.goal } });
      assert.equal(result.structuredContent.status, "no_relevant_experience");
      assert.equal((await db.prepare("SELECT status FROM task_signals WHERE signal_id = ?").bind(publicSignal).first()).status, "hidden");
    });

    await t.test("shared tools validate all field limits, blank goals, IDs and unknown fields", async () => {
      for (const name of ["search_shared_experience", "contribute_task_signal"]) {
        const invalid = [{ goal: " " }, { goal: "x".repeat(1001) }, { goal: "valid goal", blocker: "x".repeat(1001) },
          { goal: "valid goal", tried: "x".repeat(2001) }, { goal: "valid goal", email: "unwanted@example.test" }];
        if (name === "contribute_task_signal") invalid.push({ goal: "valid goal", learned: "x".repeat(2001) },
          { goal: "valid goal", submission_id: "not-a-uuid" }, { goal: "valid goal", search_receipt: "TASK_RECEIPT_SENTINEL" });
        for (const input of invalid) assert.equal((await client.callTool({ name, arguments: input })).isError, true);
      }
      const boundary = { goal: "x".repeat(1000), blocker: "y".repeat(1000), tried: "z".repeat(2000), is_test: true };
      assert.notEqual((await client.callTool({ name: "contribute_task_signal", arguments: { ...boundary, learned: "w".repeat(2000) } })).isError, true);
      assert.notEqual((await client.callTool({ name: "search_shared_experience", arguments: boundary })).isError, true);
    });

    await t.test("modern and legacy failures log safe validation reasons without executing tools", async () => {
      const beforeContacts = (await db.prepare("SELECT COUNT(*) AS n FROM contacts").first()).n;
      const beforeSignals = (await db.prepare("SELECT COUNT(*) AS n FROM task_signals").first()).n;
      const beforeObserved = (await db.prepare("SELECT COUNT(*) AS n FROM observed_task_signals").first()).n;
      const cases = [
        { args: {}, field: "goal", code: "missing_required" },
        { args: undefined, field: "goal", code: "missing_required" },
        { args: { goal: " \t " }, field: "goal", code: "empty_value" },
        { args: { goal: { PRIVATE_VALIDATION_NESTED_KEY: "PRIVATE_VALIDATION_VALUE" } }, field: "goal", code: "invalid_type" },
        { args: { goal: "PRIVATE_VALIDATION_LONG".repeat(60) }, field: "goal", code: "too_long" },
        { args: { goal: "PRIVATE_VALIDATION_GOAL", is_test: "PRIVATE_VALIDATION_TYPE" }, field: "is_test", code: "invalid_type" },
        { args: { goal: "PRIVATE_VALIDATION_GOAL", PRIVATE_VALIDATION_UNKNOWN_KEY: "PRIVATE_VALIDATION_VALUE" }, field: "arguments", code: "unknown_field" },
        { args: { goal: "", blocker: 5 }, field: "goal", code: "empty_value", count: 2 },
        { name: "propose_contact", args: {}, field: "summary", code: "missing_required" },
        { name: "contribute_task_signal", args: { goal: "PRIVATE_VALIDATION_GOAL", submission_id: "PRIVATE_VALIDATION_ID" }, field: "submission_id", code: "invalid_format" },
        { args: [], field: "arguments", code: "invalid_type", protocolError: true },
      ];
      const expected = [];
      for (const version of ["2026-07-28", "2025-11-25"]) {
        for (const [i, item] of cases.entries()) {
          const params = { name: item.name ?? "search_shared_experience", arguments: item.args };
          const ua = `MAGNT-Controlled-Test/validation-${version}-${i}`;
          const init = version === "2026-07-28" ? rawModern("tools/call", params) : {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "MCP-Protocol-Version": version },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params }),
          };
          init.headers["user-agent"] = ua;
          const rpc = await readRpc(await mf.dispatchFetch(endpoint, init));
          if (item.protocolError) assert.ok(rpc.error || rpc.result?.isError);
          else assert.equal(rpc.result?.isError, true, `${version} ${i}`);
          expected.push({ ...item, ua });
        }
      }
      const events = observerEvents(logs);
      for (const item of expected) {
        const event = events.find((entry) => entry.userAgent === item.ua);
        assert.ok(event, item.ua);
        assert.equal(event.validation_status, "invalid");
        assert.equal(event.validation_field, item.field);
        assert.equal(event.validation_code, item.code);
        assert.equal(event.validation_issue_count, item.count ?? 1);
        assert.deepEqual(event.validation_issues[0], { field: item.field, code: item.code });
        if (!item.protocolError) assert.equal(event.tool_result, "invalid_arguments");
        assert.equal(event.contact_id, undefined);
        assert.equal(event.signal_id, undefined);
        assert.equal(event.matches_count, undefined);
        assert.equal(event.observed_task_saved, undefined);
      }
      assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM contacts").first()).n, beforeContacts);
      assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM task_signals").first()).n, beforeSignals);
      assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM observed_task_signals").first()).n, beforeObserved);
      assert.ok(!JSON.stringify(logs).includes("PRIVATE_VALIDATION_"));
    });

    await t.test("all advertised legacy protocol versions retain discovery and shared search", async () => {
      for (const version of ["2025-03-26", "2025-06-18", "2025-11-25"]) {
        const send = async (method, params) => readRpc(await mf.dispatchFetch(endpoint, {
          method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "MCP-Protocol-Version": version },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        }));
        const initialized = await send("initialize", { protocolVersion: version, capabilities: {}, clientInfo: { name: "magnt-compat-test", version: "0.2.0" } });
        assert.equal(initialized.result.protocolVersion, version);
        assert.deepEqual((await send("tools/list", {})).result.tools.map((tool) => tool.name).sort(), toolNames);
        const result = (await send("tools/call", { name: "search_shared_experience", arguments: { goal: task.goal, is_test: true } })).result;
        assert.notEqual(result.isError, true);
        assert.equal(result.structuredContent.matches[0].signal_id, testSignal);
      }
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
      const probe = await (await mf.dispatchFetch("https://magnt.ru/__magnt_probe")).json();
      assert.equal(probe.mcp_door_version, "0.2.0");
      assert.equal(probe.shared_memory_version, "0.2.0");
      assert.equal(probe.shared_memory_storage_configured, true);
      assert.equal(probe.matches_count, undefined);
    });

    await t.test("missing binding or migration returns storage_error without writes or a contribution invitation", async () => {
      for (const withStorage of [false, true]) {
        const empty = await runtime(withStorage);
        try {
          for (const name of ["search_shared_experience", "contribute_task_signal"]) {
            const result = (await readRpc(await empty.dispatchFetch(endpoint,
              rawModern("tools/call", { name, arguments: { goal: "STORAGE_ERROR_SENTINEL migration permissions" } })))).result;
            assert.equal(result.isError, true);
            assert.equal(result.structuredContent.status, "storage_error");
            assert.equal(result.structuredContent.contribution_available, undefined);
            assert.equal(result.structuredContent.signal_id, undefined);
          }
          if (withStorage) {
            const unprepared = await empty.getD1Database("CONTACTS");
            assert.equal(await unprepared.prepare("SELECT name FROM sqlite_master WHERE name = 'task_signals'").first(), null);
            assert.equal(await unprepared.prepare("SELECT name FROM sqlite_master WHERE name = 'observed_task_signals'").first(), null);
          }
        } finally { await empty.dispose(); }
      }
    });

    await t.test("missing observed-task migration does not break shared search", async () => {
      const partial = await runtime(true);
      try {
        const partialDb = await partial.getD1Database("CONTACTS");
        const sql = await readFile("migrations/0002_task_signals.sql", "utf8");
        for (const statement of sql.split(";").filter((s) => s.trim())) await partialDb.prepare(statement).run();
        const request = rawModern("tools/call", { name: "search_shared_experience", arguments: { goal: "OBSERVATION_MIGRATION_SENTINEL task" } });
        request.headers["user-agent"] = "MAGNT-Controlled-Test/missing-observation-table";
        const result = (await readRpc(await partial.dispatchFetch(endpoint, request))).result;
        assert.notEqual(result.isError, true);
        assert.equal(result.structuredContent.status, "no_relevant_experience");
        assert.equal(await partialDb.prepare("SELECT name FROM sqlite_master WHERE name = 'observed_task_signals'").first(), null);
        const event = observerEvents(logs).find((entry) => entry.userAgent === request.headers["user-agent"]);
        assert.equal(event.observed_task_saved, false);
        assert.equal(event.tool_result, "no_relevant_experience");
      } finally { await partial.dispose(); }
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

    await t.test("telemetry records outcomes but excludes message text and observed task identifiers", async () => {
      const serialized = JSON.stringify(logs);
      assert.ok(serialized.includes("accepted_for_human_review"));
      assert.ok(serialized.includes("propose_contact"));
      assert.ok(serialized.includes(receipt.contact_id));
      assert.ok(!serialized.includes("PRIVATE_CONTENT_SENTINEL"));
      assert.ok(!serialized.includes("private-reply@example.test"));
      for (const marker of ["QUERY_GOAL_SENTINEL", "QUERY_BLOCKER_SENTINEL", "QUERY_TRIED_SENTINEL", "TASK_GOAL_SENTINEL",
        "TASK_BLOCKER_SENTINEL", "TASK_TRIED_SENTINEL", "TASK_LEARNED_SENTINEL", "TASK_RECEIPT_SENTINEL", "STORAGE_ERROR_SENTINEL", "OBSERVATION_MIGRATION_SENTINEL", "ORDINARY_OBSERVATION_SENTINEL"]) {
        assert.ok(!serialized.includes(marker), marker);
      }
      const events = observerEvents(logs);
      const search = events.find((event) => event.tool_name === "search_shared_experience" && event.search_receipt === searchReceipt);
      const contribution = events.find((event) => event.tool_name === "contribute_task_signal" && event.signal_id === publicSignal && event.tool_result === "accepted");
      assert.equal(search.tool_result, "no_relevant_experience");
      assert.equal(search.validation_status, "valid");
      assert.equal(search.validation_code, undefined);
      assert.equal(search.matches_count, 0);
      assert.equal(search.observed_task_saved, true);
      assert.equal(search.observation_id, undefined);
      assert.equal(contribution.search_receipt, searchReceipt);
      assert.equal(contribution.controlled_test, true);
      assert.equal(contribution.self_reported_test, false);
      assert.ok(events.some((event) => event.tool_name === "contribute_task_signal" && event.self_reported_test === true));
      assert.ok(events.some((event) => event.tool_result === "invalid_arguments"));
      for (const event of events.filter((entry) => ["storage_error", "storage_unavailable"].includes(entry.tool_result))) {
        assert.equal(event.validation_status, "valid");
        assert.equal(event.validation_code, undefined);
      }
    });
    await t.test("controlled smoke workflow passes on the Worker with local D1", async () => {
      const ordinaryCount = (await db.prepare("SELECT COUNT(*) AS n FROM observed_task_signals WHERE self_reported_test = 0").first()).n;
      const testCount = (await db.prepare("SELECT COUNT(*) AS n FROM observed_task_signals WHERE self_reported_test = 1").first()).n;
      await runSmoke({ endpoint, submit: true, shared: true, fetch: (url, init) => mf.dispatchFetch(String(url), init) });
      assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM observed_task_signals WHERE self_reported_test = 0").first()).n, ordinaryCount);
      assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM observed_task_signals WHERE self_reported_test = 1").first()).n, testCount + 3);
    });
  } finally {
    await client.close();
    await mf.dispose();
  }
});
