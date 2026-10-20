import assert from "node:assert/strict";
import test from "node:test";
import { handleA2A } from "../src/a2a.js";

function messageRequest({ id = "test", url = "https://magnt.ru/a2a", headers = {}, message } = {}) {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", "a2a-version": "1.0", ...headers },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "SendMessage",
      params: {
        message: message || {
          messageId: "m-1",
          role: "ROLE_USER",
          parts: [{ text: "What is MAGNT?" }],
        },
      },
    }),
  });
}

test("A2A SendMessage returns discovery guidance", async () => {
  const event = {};
  const response = await handleA2A(messageRequest({ id: "test-1" }), event);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("a2a-version"), "1.0");
  assert.equal(response.headers.get("content-type"), "application/json");
  const body = await response.json();
  assert.equal(body.jsonrpc, "2.0");
  assert.equal(body.id, "test-1");
  assert.equal(body.result.message.role, "ROLE_AGENT");
  assert.equal(typeof body.result.message.contextId, "string");
  assert.ok(body.result.message.contextId.length > 0);
  assert.match(body.result.message.parts[0].text, /https:\/\/magnt\.ru\/mcp/);
  assert.equal(event.event_type, "a2a_request");
  assert.equal(event.a2a_method, "SendMessage");
  assert.equal(event.a2a_protocol_version, "1.0");
  assert.equal(event.outcome, "success");
});

test("A2A preserves an incoming contextId", async () => {
  const event = {};
  const response = await handleA2A(messageRequest({
    id: 2,
    message: {
      messageId: "m-2",
      contextId: "ctx-1",
      role: "ROLE_USER",
      parts: [{ text: "Continue" }],
    },
  }), event);
  const body = await response.json();
  assert.equal(body.result.message.contextId, "ctx-1");
});

test("A2A accepts the v1 version as a query parameter", async () => {
  const event = {};
  const request = new Request("https://magnt.ru/a2a?A2A-Version=1.0", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "query-version",
      method: "SendMessage",
      params: { message: { messageId: "m-query", role: "ROLE_USER", parts: [{ text: "Hello" }] } },
    }),
  });
  const response = await handleA2A(request, event);
  const body = await response.json();
  assert.equal(body.id, "query-version");
  assert.ok(body.result?.message);
  assert.equal(event.a2a_protocol_version, "1.0");
});

test("A2A rejects unsupported methods", async () => {
  const event = {};
  const request = new Request("https://magnt.ru/a2a", {
    method: "POST",
    headers: { "content-type": "application/json", "a2a-version": "1.0" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "GetTask", params: {} }),
  });
  const response = await handleA2A(request, event);
  const body = await response.json();
  assert.equal(body.id, 3);
  assert.equal(body.error.code, -32601);
  assert.equal(event.outcome, "protocol_error");
});

test("A2A rejects an unsupported protocol version and preserves request id", async () => {
  const event = {};
  const response = await handleA2A(messageRequest({ id: 4, headers: { "a2a-version": "9.9" } }), event);
  const body = await response.json();
  assert.equal(body.id, 4);
  assert.equal(body.error.code, -32009);
  assert.equal(event.a2a_protocol_version, "9.9");
  assert.equal(event.outcome, "protocol_error");
});

test("A2A accepts all JSON data values in a data part", async () => {
  for (const data of [null, true, 7, "value", [1, 2], { key: "value" }]) {
    const event = {};
    const response = await handleA2A(messageRequest({
      id: "data-part",
      message: { messageId: "m-data", role: "ROLE_USER", parts: [{ data }] },
    }), event);
    const body = await response.json();
    assert.ok(body.result?.message, `data=${JSON.stringify(data)} should be valid`);
    assert.equal(event.outcome, "success");
  }
});

test("A2A accepts ProtoJSON URL-safe and unpadded base64 raw parts", async () => {
  for (const raw of ["_w", "AQ", "AQI=", "AQID"]) {
    const event = {};
    const response = await handleA2A(messageRequest({
      id: "raw-valid",
      message: { messageId: "m-raw", role: "ROLE_USER", parts: [{ raw }] },
    }), event);
    const body = await response.json();
    assert.ok(body.result?.message, `${raw} should be valid ProtoJSON base64`);
  }
});

test("A2A rejects malformed message parts", async () => {
  for (const badPart of [null, {}, { text: "x", url: "https://example.com" }, { raw: "%%%" }, { raw: "A" }, { raw: "==" }]) {
    const event = {};
    const response = await handleA2A(messageRequest({
      id: "bad-part",
      message: { messageId: "m-bad", role: "ROLE_USER", parts: [badPart] },
    }), event);
    const body = await response.json();
    assert.equal(body.error.code, -32602);
    assert.equal(event.outcome, "protocol_error");
  }
});

test("A2A rejects invalid JSON-RPC ids", async () => {
  for (const badId of [{}, [], true]) {
    const event = {};
    const request = new Request("https://magnt.ru/a2a", {
      method: "POST",
      headers: { "content-type": "application/json", "a2a-version": "1.0" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: badId,
        method: "SendMessage",
        params: { message: { messageId: "m-id", role: "ROLE_USER", parts: [{ text: "Hello" }] } },
      }),
    });
    const response = await handleA2A(request, event);
    const body = await response.json();
    assert.equal(body.id, null);
    assert.equal(body.error.code, -32600);
  }
});

test("A2A does not answer JSON-RPC notifications", async () => {
  const event = {};
  const request = new Request("https://magnt.ru/a2a", {
    method: "POST",
    headers: { "content-type": "application/json", "a2a-version": "1.0" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "SendMessage",
      params: { message: { messageId: "m-notify", role: "ROLE_USER", parts: [{ text: "Hello" }] } },
    }),
  });
  const response = await handleA2A(request, event);
  assert.equal(response.status, 204);
  assert.equal(await response.text(), "");
  assert.equal(event.outcome, "notification_ignored");
});

test("A2A rejects bodies above 24 KiB before JSON parsing", async () => {
  const event = {};
  const oversized = "x".repeat(24 * 1024 + 1);
  const request = new Request("https://magnt.ru/a2a", {
    method: "POST",
    headers: { "content-type": "application/json", "a2a-version": "1.0" },
    body: oversized,
  });
  const response = await handleA2A(request, event);
  assert.equal(response.status, 413);
  assert.equal(event.outcome, "body_too_large");
});
