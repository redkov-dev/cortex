import assert from "node:assert/strict";
import test from "node:test";
import { handleA2A } from "../src/a2a.js";

test("A2A SendMessage returns discovery guidance", async () => {
  const event = {};
  const request = new Request("https://magnt.ru/a2a", {
    method: "POST",
    headers: { "content-type": "application/json", "a2a-version": "1.0" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "test-1",
      method: "SendMessage",
      params: {
        message: {
          messageId: "m-1",
          role: "ROLE_USER",
          parts: [{ text: "What is MAGNT?" }],
        },
      },
    }),
  });

  const response = await handleA2A(request, event);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("a2a-version"), "1.0");
  const body = await response.json();
  assert.equal(body.jsonrpc, "2.0");
  assert.equal(body.id, "test-1");
  assert.equal(body.result.message.role, "ROLE_AGENT");
  assert.match(body.result.message.parts[0].text, /https:\/\/magnt\.ru\/mcp/);
  assert.equal(event.event_type, "a2a_request");
  assert.equal(event.a2a_method, "SendMessage");
  assert.equal(event.outcome, "success");
});

test("A2A rejects unsupported methods without exposing request content", async () => {
  const event = {};
  const request = new Request("https://magnt.ru/a2a", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "GetTask", params: {} }),
  });

  const response = await handleA2A(request, event);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.error.code, -32601);
  assert.equal(event.outcome, "protocol_error");
});
