const A2A_VERSION = "1.0";

function jsonRpcError(id, code, message) {
  return new Response(JSON.stringify({
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message },
  }), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "a2a-version": A2A_VERSION,
    },
  });
}

function validPart(part) {
  if (!part || typeof part !== "object" || Array.isArray(part)) return false;

  const contentFields = ["text", "raw", "url", "data"];
  const present = contentFields.filter((field) => Object.prototype.hasOwnProperty.call(part, field));
  if (present.length !== 1) return false;

  const field = present[0];
  if (field === "data") {
    return part.data !== null && typeof part.data === "object" && !Array.isArray(part.data);
  }
  return typeof part[field] === "string" && part[field].length > 0;
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

  let body;
  try {
    body = await request.json();
  } catch {
    event.outcome = "protocol_error";
    return jsonRpcError(null, -32700, "Parse error");
  }

  const id = body?.id ?? null;
  const requestedVersion = request.headers.get("a2a-version")
    || url.searchParams.get("A2A-Version")
    || "0.3";
  event.a2a_protocol_version = requestedVersion;

  if (requestedVersion !== A2A_VERSION) {
    event.outcome = "protocol_error";
    return jsonRpcError(id, -32009, "Version not supported");
  }

  event.a2a_method = typeof body?.method === "string" ? body.method : "";

  if (body?.jsonrpc !== "2.0" || typeof body?.method !== "string") {
    event.outcome = "protocol_error";
    return jsonRpcError(id, -32600, "Invalid Request");
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
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "a2a-version": A2A_VERSION,
    },
  });
}
