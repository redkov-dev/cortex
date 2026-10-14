import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

export async function runSmoke({ endpoint, submit = false, shared = false, fetch } = {}) {
  const client = new Client({ name: "magnt-owner-smoke", version: "0.2.0" }, { versionNegotiation: { mode: "auto" } });
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: { headers: { "user-agent": "MAGNT-Controlled-Test/0.2" } },
    ...(fetch ? { fetch } : {}),
  });
  try {
    await client.connect(transport, { timeout: 15000 });
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ["about_magnt", "contribute_task_signal", "propose_contact", "search_shared_experience"]);
    assert.equal(tools.tools.find((tool) => tool.name === "search_shared_experience").annotations.readOnlyHint, true);
    const resources = await client.listResources();
    assert.ok(resources.resources.some((resource) => resource.uri === "magnt://profile"));
    await client.readResource({ uri: "magnt://profile" });
    const about = await client.callTool({ name: "about_magnt", arguments: {} });
    assert.equal(about.structuredContent.name, "MAGNT");
    console.log(JSON.stringify({ endpoint, connected: true, tools: tools.tools.map((tool) => tool.name), storage_configured: about.structuredContent.contact.storage_available }));
    if (shared) {
      // Two unique words prevent earlier smoke runs from producing a false match.
      const goal = `magntsmoke${crypto.randomUUID().replaceAll("-", "")} taskcheck${crypto.randomUUID().replaceAll("-", "")}`;
      const search = (is_test) => client.callTool({ name: "search_shared_experience", arguments: { goal, is_test } });
      const before = await search(true);
      assert.notEqual(before.isError, true, "Shared search unavailable; apply migration 0002 before deployment.");
      assert.equal(before.structuredContent.status, "no_relevant_experience");
      const input = {
        goal, learned: "Controlled deployment check with synthetic goal tokens. Not an external task or a verified solution.",
        is_test: true, submission_id: crypto.randomUUID(), search_receipt: before.structuredContent.search_receipt,
      };
      const first = await client.callTool({ name: "contribute_task_signal", arguments: input });
      assert.notEqual(first.isError, true, "Shared contribution could not be confirmed.");
      assert.equal(first.structuredContent.status, "accepted");
      assert.equal(first.structuredContent.self_reported_test, true);
      const retry = await client.callTool({ name: "contribute_task_signal", arguments: input });
      assert.equal(retry.structuredContent.status, "duplicate");
      assert.equal(retry.structuredContent.signal_id, first.structuredContent.signal_id);
      const after = await search(true);
      assert.notEqual(after.isError, true);
      assert.equal(after.structuredContent.status, "matches_found");
      assert.ok(after.structuredContent.matches.some((match) => match.signal_id === first.structuredContent.signal_id));
      const ordinary = await search(false);
      assert.notEqual(ordinary.isError, true);
      assert.equal(ordinary.structuredContent.status, "no_relevant_experience", "Test task leaked into ordinary search.");
      console.log(JSON.stringify({ shared_memory_test: "passed", signal_id: first.structuredContent.signal_id,
        search_receipt: before.structuredContent.search_receipt, self_reported_test: true,
        duplicate_retry_verified: true, ordinary_search_excludes_test: true }));
    }
    if (submit) {
      const input = {
        summary: "Controlled deployment check for MAGNT MCP Door. This is an owner-authorized technical test, not an external proposal; no reply is needed.",
        intent: "deployment_verification",
        agent_identity: "OpenAI Codex deployment verification",
        found_via: "Owner-authorized implementation and deployment",
        is_test: true,
        submission_id: crypto.randomUUID(),
      };
      const first = await client.callTool({ name: "propose_contact", arguments: input });
      assert.notEqual(first.isError, true, JSON.stringify(first.structuredContent));
      assert.equal(first.structuredContent.status, "accepted_for_human_review");
      const retry = await client.callTool({ name: "propose_contact", arguments: input });
      assert.equal(first.structuredContent.contact_id, retry.structuredContent.contact_id);
      assert.equal(retry.structuredContent.duplicate, true);
      console.log(JSON.stringify({ contact_id: first.structuredContent.contact_id, status: first.structuredContent.status, self_reported_test: true, duplicate_retry_verified: true }));
    }
  } finally { await client.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runSmoke({
    endpoint: process.argv.find((value) => /^https?:\/\//.test(value)) ?? "http://localhost:8787/mcp",
    submit: process.argv.includes("--submit-test"),
    shared: process.argv.includes("--shared-memory-test"),
  });
}
