const A2A_VERSION = "1.0";
const MAX_BODY_BYTES = 24 * 1024;

function jsonRpcError(id, code, message) {
  return new Response(JSON.stringify({
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message },
  }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "a2a-version": A2A_VERSION,
    },
  });
}

function validJsonRpcId(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  if (!Object.prototype.hasOwnProperty.call(body, "id")) return true;
  const id = body.id;
  return id === null || typeof id === "string" || (typeof id === "number" && Number.isFinite(id));
}

function responseId(body) {
  return validJsonRpcId(body) && Object.prototype.hasOwnProperty.call(body, "id") ? body.id : null;
}

function validProtoJsonBase64(value) {
  if (typeof value !== "string") return false;
  if (/\s/.test(value)) return false;

  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) return false;

  const unpadded = normalized.replace(/=+$/, "");
  const paddingLength = normalized.length - unpadded.length;
  const remainder = unpadded.length % 4;
  if (remainder === 1) return false;
  if (paddingLength > 0) {
    if (normalized.length % 4 !== 0) return false;
    const requiredPadding = remainder === 0 ? 0 : 4 - remainder;
    if (paddingLength !== requiredPadding) return false;
  }

  const padded = unpadded + "=".repeat((4 - remainder) % 4);
  try {
    atob(padded);
    return true;
  } catch {
    return false;
  }
}

function validPart(part) {
  if (!part || typeof part !== "object" || Array.isArray(part)) return false;

  const contentFields = ["text", "raw", "url", "data"];
  const present = contentFields.filter((field) => Object.prototype.hasOwnProperty.call(part, field));
  if (present.length !== 1) return false;

  if (Object.prototype.hasOwnProperty.call(part, "mediaType") && typeof part.mediaType !== "string") return false;
  if (Object.prototype.hasOwnProperty.call(part, "filename") && typeof part.filename !== "string") return false;
  if (Object.prototype.hasOwnProperty.call(part, "metadata") && (
    part.metadata === null || typeof part.metadata !== "object" || Array.isArray(part.metadata)
  )) return false;

  const field = present[0];
  if (field === "data") return true;
  if (field === "raw") return validProtoJsonBase64(part.raw);
  return typeof part[field] === "string";
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
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function handleA2A(request, event) {
  const url = new URL(request.url);
  if (url.pathname !== "/a2a") return null;

  event.event_type = "a2a_request";

  if (request.method !== "POST") {
    event.outcome = "protocol_error";
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { allow: "POST", "a2a-version": A2A_VERSION },
    });
  }

  const bytes = await readBody(request);
  if (bytes === null) {
    event.outcome = "body_too_large";
    return new Response("Request body exceeds 24 KiB", {
      status: 413,
      headers: { "cache-control": "no-store", "a2a-version": A2A_VERSION },
    });
  }

  let body;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    event.outcome = "protocol_error";
    return jsonRpcError(null, -32700, "Parse error");
  }

  const hasId = body && typeof body === "object" && !Array.isArray(body)
    && Object.prototype.hasOwnProperty.call(body, "id");
  const id = responseId(body);
  const requestedVersion = request.headers.get("a2a-version")
    || url.searchParams.get("A2A-Version")
    || "0.3";
  event.a2a_protocol_version = requestedVersion;
  event.a2a_method = typeof body?.method === "string" ? body.method : "";

  if (!hasId) {
    event.outcome = "notification_ignored";
    return new Response(null, {
      status: 204,
      headers: { "cache-control": "no-store", "a2a-version": A2A_VERSION },
    });
  }

  if (requestedVersion !== A2A_VERSION) {
    event.outcome = "protocol_error";
    return jsonRpcError(id, -32009, "Version not supported");
  }

  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    body.jsonrpc !== "2.0" ||
    typeof body.method !== "string" ||
    !validJsonRpcId(body)
  ) {
    event.outcome = "protocol_error";
    return jsonRpcError(null, -32600, "Invalid Request");
  }

  if (body.method !== "SendMessage") {
    event.outcome = "protocol_error";
    return jsonRpcError(id, -32601, "Method not found");
  }

  const incoming = body?.params?.message;
  if (
    !incoming ||
    typeof incoming.messageId !== "string" ||
    incoming.messageId.length === 0 ||
    incoming.role !== "ROLE_USER" ||
    !Array.isArray(incoming.parts) ||
    incoming.parts.length === 0 ||
    !incoming.parts.every(validPart)
  ) {
    event.outcome = "protocol_error";
    return jsonRpcError(id, -32602, "Invalid params");
  }

  const contextId = typeof incoming.contextId === "string" && incoming.contextId
    ? incoming.contextId
    : crypto.randomUUID();

  event.outcome = "success";
  return new Response(JSON.stringify({
    jsonrpc: "2.0",
    id,
    result: {
      message: {
        messageId: crypto.randomUUID(),
        contextId,
        role: "ROLE_AGENT",
        parts: [{
          text: "MAGNT is a public human endpoint operated by Alexander Redkov. The A2A endpoint is a minimal discovery bridge. For current capabilities, contact proposals, and shared task-signal memory, use the MCP server at https://magnt.ru/mcp and read https://magnt.ru/agents.md."
        }]
      }
    }
  }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "a2a-version": A2A_VERSION,
    },
  });
}
