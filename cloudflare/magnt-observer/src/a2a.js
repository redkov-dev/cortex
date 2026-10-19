const A2A_VERSION = "1.0";

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
  if (field === "raw") return typeof part.raw === "string" && /^[A-Za-z0-9+/]*={0,2}$/.test(part.raw);
  return typeof part[field] === "string";
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

  const id = responseId(body);
  const requestedVersion = request.headers.get("a2a-version")
    || url.searchParams.get("A2A-Version")
    || "0.3";
  event.a2a_protocol_version = requestedVersion;

  if (requestedVersion !== A2A_VERSION) {
    event.outcome = "protocol_error";
    return jsonRpcError(id, -32009, "Version not supported");
  }

  event.a2a_method = typeof body?.method === "string" ? body.method : "";

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
