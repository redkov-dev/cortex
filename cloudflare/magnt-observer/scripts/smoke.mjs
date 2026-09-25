import assert from "node:assert/strict";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const endpoint = process.argv.find((value) => /^https?:\/\//.test(value)) ?? "http://localhost:8787/mcp";
const submit = process.argv.includes("--submit-test");
const client = new Client({ name: "magnt-owner-smoke", version: "0.1.0" }, { versionNegotiation: { mode: "auto" } });
const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
  requestInit: { headers: { "user-agent": "MAGNT-Controlled-Test/0.1" } },
});
try {
  await client.connect(transport, { timeout: 15000 });
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ["about_magnt", "propose_contact"]);
  const resources = await client.listResources();
  assert.ok(resources.resources.some((resource) => resource.uri === "magnt://profile"));
  await client.readResource({ uri: "magnt://profile" });
  const about = await client.callTool({ name: "about_magnt", arguments: {} });
  assert.equal(about.structuredContent.name, "MAGNT");
  console.log(JSON.stringify({ endpoint, connected: true, tools: tools.tools.map((tool) => tool.name), storage_configured: about.structuredContent.contact.storage_available }));
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
