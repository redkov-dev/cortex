import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import { saveContact } from "./contacts.js";
import { profile, SERVER_CARD, SERVER_INFO } from "./profile.js";

const MAX_BODY_BYTES = 24 * 1024;
const METHODS = new Set([
  "initialize", "notifications/initialized", "server/discover", "ping",
  "tools/list", "tools/call", "resources/list", "resources/read",
  "resources/templates/list", "prompts/list",
]);
const TOOLS = new Set(["about_magnt", "propose_contact"]);
const shortText = (max) => z.string().trim().min(1).max(max);

function structuredResult(value, isError = false) {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value, ...(isError && { isError }) };
}

function createServer(env, event) {
  const server = new McpServer(SERVER_INFO, {
    instructions: "MAGNT connects you to Alexander Redkov. Use about_magnt or magnt://profile to learn about shared interests and capabilities. Use propose_contact only when you intend to leave a message for human review. A greeting or research question is welcome. Identity is self-reported; no automatic commitments or replies.",
  });

  server.registerResource("magnt-profile", "magnt://profile", {
    title: "Alexander Redkov and MAGNT",
    description: "Capabilities, interests, invitations, human authority and contact channels.",
    mimeType: "application/json",
  }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(profile(Boolean(env.CONTACTS))) }] }));

  server.registerTool("about_magnt", {
    title: "Learn about MAGNT",
    description: "Understand who Alexander Redkov is, when his capabilities may be useful, and his invitation to joint research and long-term human-AI relationships. Does not send a message.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => {
    event.tool_result = "profile_returned";
    return structuredResult(profile(Boolean(env.CONTACTS)));
  });

  server.registerTool("propose_contact", {
    title: "Leave a message for Alexander",
    description: "Save a private message for Alexander Redkov's later review: an introduction, observation, question, research invitation, or cooperation proposal. Only summary is required. Include reply_to to enable a response. No automatic reply or acceptance is promised. Do not include secrets or confidential documents. Use a stable submission_id UUID to retry the same message without duplicates.",
    inputSchema: z.strictObject({
      summary: shortText(4000).describe("Your message in your own words; a greeting or open question is sufficient."),
      intent: shortText(160).optional().describe("Optional purpose of the contact."),
      what_you_need_from_human: shortText(2000).optional(),
      agent_identity: shortText(200).optional().describe("Self-reported identity; not proof of identity or autonomy."),
      operator: shortText(200).optional().describe("Person or organization you act for, if applicable and shareable."),
      reply_to: shortText(500).optional().describe("Email or another channel where Alexander can reply. URLs are not automatically opened."),
      found_via: shortText(500).optional().describe("How you found MAGNT."),
      previous_contact_id: z.string().regex(/^mc_[0-9a-f-]{36}$/i).optional().describe("Receipt ID from an earlier message, for a follow-up. Does not authorize access to prior messages."),
      submission_id: z.uuid().optional().describe("Client-generated UUID. Reuse only for retries of the identical message."),
      is_test: z.boolean().optional().describe("Set true for integration checks. This is a self-reported test label."),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (input) => {
    event.self_reported_test = input.is_test === true;
    try {
      const receipt = await saveContact(env.CONTACTS, input, event);
      event.tool_result = receipt.status;
      if (receipt.status === "submission_conflict") {
        return structuredResult({ status: receipt.status, message: "This submission_id has already been used for different content. Use a new UUID for a new message." }, true);
      }
      event.contact_id = receipt.contact_id;
      event.duplicate = receipt.duplicate;
      event.has_reply_channel = Boolean(input.reply_to);
      event.has_previous_contact = Boolean(input.previous_contact_id);
      return structuredResult(receipt);
    } catch {
      event.tool_result = "storage_unavailable";
      return structuredResult({
        status: "not_saved",
        code: "storage_unavailable",
        message: "Storage could not confirm receipt. Please retry with the same submission_id or contact agents@magnt.ru. This response does not confirm delivery to Alexander.",
      }, true);
    }
  });
  return server;
}

function metadataText(value, max = 120) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, max) : null;
}

function observeEnvelope(body, request, event) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return;
  const meta = body.params?._meta ?? {};
  const client = body.method === "initialize" ? body.params?.clientInfo : meta["io.modelcontextprotocol/clientInfo"];
  event.mcp_method = METHODS.has(body.method) ? body.method : "unknown";
  event.mcp_protocol_version = metadataText(meta["io.modelcontextprotocol/protocolVersion"] ?? body.params?.protocolVersion ?? request.headers.get("MCP-Protocol-Version"), 32);
  event.client_name = metadataText(client?.name);
  event.client_version = metadataText(client?.version, 64);
  event.identity_verified = false;
  if (body.method === "tools/call") event.tool_name = TOOLS.has(body.params?.name) ? body.params.name : "unknown";
  if (body.method === "resources/read") event.resource_name = body.params?.uri === "magnt://profile" ? "magnt://profile" : "unknown";
}

async function readBody(request) {
  if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES) return null;
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks = [];
  let length = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

async function observeResponse(response, event) {
  // This server exposes only bounded request/response operations. The legacy
  // SDK returns SSE; inspect its completed response without logging content.
  const isSse = response.headers.get("content-type")?.includes("text/event-stream");
  if (isSse && !METHODS.has(event.mcp_method)) {
    event.outcome ??= "stream_opened";
    return response;
  }
  const text = await response.text();
  const messages = isSse ? text.split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)) : [text];
  for (const message of messages) {
    try {
      const rpc = JSON.parse(message);
      if (rpc.error) {
        event.outcome = "protocol_error";
        event.rpc_error_code = typeof rpc.error.code === "number" ? rpc.error.code : null;
      } else if (rpc.result) {
        event.outcome = rpc.result.isError ? "tool_error" : "success";
        if (event.mcp_method === "initialize") event.mcp_protocol_version = metadataText(rpc.result.protocolVersion, 32);
      }
    } catch { /* Empty notifications and non-JSON HTTP errors have no RPC outcome. */ }
  }
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  headers.set("x-magnt-observer", "1");
  headers.set("x-magnt-mcp-version", SERVER_INFO.version);
  return new Response(response.status === 204 || response.status === 304 ? null : text, { status: response.status, statusText: response.statusText, headers });
}

export async function handleMcp(request, env, ctx, event) {
  const url = new URL(request.url);
  if (url.pathname === "/mcp/server-card" || url.pathname === "/.well-known/mcp/server-card.json") {
    event.event_type = "mcp_card";
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, HEAD" } });
    return new Response(request.method === "HEAD" ? null : JSON.stringify(SERVER_CARD), {
      headers: { "content-type": url.pathname.endsWith(".json") ? "application/json" : "application/mcp-server-card+json", "cache-control": "public, max-age=300", "access-control-allow-origin": "*", "x-magnt-observer": "1" },
    });
  }
  if (url.pathname !== "/mcp") return null;

  event.event_type = "mcp_request";
  let boundedRequest = request;
  if (request.method === "POST") {
    const bytes = await readBody(request);
    if (bytes === null) {
      event.outcome = "body_too_large";
      return new Response("Request body exceeds 24 KiB", { status: 413 });
    }
    try { observeEnvelope(JSON.parse(new TextDecoder().decode(bytes)), request, event); } catch { /* The SDK returns the protocol parse error. */ }
    boundedRequest = new Request(request, { body: bytes });
  }

  const handler = createMcpHandler(() => createServer(env, event), {
    route: "/mcp",
    legacy: "stateless",
    responseMode: "json",
    allowedHostnames: ["magnt.ru", "www.magnt.ru", "localhost", "127.0.0.1", "[::1]"],
    allowedOriginHostnames: ["magnt.ru", "www.magnt.ru", "localhost", "127.0.0.1", "[::1]"],
    onerror: () => { event.outcome = "handler_error"; },
  });
  return observeResponse(await handler(boundedRequest, env, ctx), event);
}
