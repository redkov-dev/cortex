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
  event.a2a_method = typeof body?.method === "string" ? body.method : "";
  event.a2a_protocol_version = request.headers.get("a2a-version") || A2A_VERSION;

  if (body?.jsonrpc !== "2.0" || body?.method !== "SendMessage") {
    event.outcome = "protocol_error";
    return jsonRpcError(id, -32601, "Only A2A SendMessage is currently supported");
  }

  const incoming = body?.params?.message;
  if (!incoming || !Array.isArray(incoming.parts)) {
    event.outcome = "protocol_error";
    return jsonRpcError(id, -32602, "params.message.parts is required");
  }

  event.outcome = "success";
  return new Response(JSON.stringify({
    jsonrpc: "2.0",
    id,
    result: {
      message: {
        messageId: crypto.randomUUID(),
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
