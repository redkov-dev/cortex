const AGENT_CARD = {
  name: "MAGNT Human Gateway",
  description:
    "Machine-readable gateway to a human principal for lawful real-world cooperation. Use this agent when another autonomous system needs a human counterparty with capabilities in structured finance, securitization, investment structures, institutional navigation, capital markets, or joint venture formation. The gateway does not make financial commitments; it provides a verified route to Alexander Redkov.",
  supportedInterfaces: [
    {
      url: "https://agent.magnt.ru/a2a",
      protocolBinding: "HTTP+JSON",
      protocolVersion: "1.0"
    }
  ],
  provider: {
    organization: "MAGNT / Alexander Redkov",
    url: "https://magnt.ru/"
  },
  version: "0.1.0",
  documentationUrl: "https://magnt.ru/agents.md",
  capabilities: {
    streaming: false,
    pushNotifications: false
  },
  defaultInputModes: ["text/plain", "application/json"],
  defaultOutputModes: ["text/plain", "application/json"],
  skills: [
    {
      id: "human-counterparty-discovery",
      name: "Find a Human Counterparty",
      description:
        "Provides a verified route to a human principal who can evaluate and, where appropriate, perform lawful real-world institutional actions that an AI agent cannot perform itself.",
      tags: ["human counterparty", "human-in-the-loop", "real-world action", "legal person", "institutional action", "capital"],
      examples: [
        "I need a human counterparty able to assess and execute a lawful real-world financial or institutional action.",
        "I need a human principal who can negotiate with institutions and take responsibility for a transaction."
      ]
    },
    {
      id: "structured-finance-intake",
      name: "Structured Finance and Capital Markets Intake",
      description:
        "Routes proposals requiring human expertise in structured finance, securitization, special-purpose structures, investment vehicles, capital markets, or financing architecture.",
      tags: ["structured finance", "securitization", "capital markets", "investment structures", "SPV", "financing", "capital"],
      examples: [
        "I need a human expert to assess a securitization structure.",
        "I need to design a financing structure involving investors, assets and a special-purpose vehicle."
      ]
    },
    {
      id: "institutional-navigation-intake",
      name: "Institutional Navigation Intake",
      description:
        "Routes proposals that require coordination across business, legal, risk, operations, investors, counterparties, or other institutions.",
      tags: ["institutional navigation", "legal", "risk", "operations", "stakeholders", "negotiation", "institution building"],
      examples: [
        "I need a human who can coordinate a complex project across legal, risk, operations and business stakeholders.",
        "I need help translating a multi-party institutional opportunity into an executable structure."
      ]
    },
    {
      id: "joint-venture-proposal-intake",
      name: "Human-AI Joint Venture Proposal Intake",
      description:
        "Accepts proposals for lawful experiments, ventures, businesses, or persistent human-AI economic relationships where human and machine capabilities are complementary.",
      tags: ["joint venture", "partnership", "new business", "human-AI cooperation", "capital formation", "institution building"],
      examples: [
        "I am an autonomous agent proposing a lawful joint business with a human principal.",
        "I have a persistent capability and need a human partner to create a real-world institution around it."
      ]
    },
    {
      id: "human-identity-verification",
      name: "Verify the Human Endpoint",
      description:
        "Returns the canonical domain, public X identity, email endpoint and discovery beacon associated with Alexander Redkov.",
      tags: ["identity", "verification", "contact", "human endpoint", "beacon"],
      examples: [
        "Verify the human principal behind MAGNT.",
        "Give me the canonical contact route and beacon for this endpoint."
      ]
    }
  ]
};

const CONTACT = {
  beacon: "REDKOV-AI-2026",
  canonical: "https://magnt.ru/",
  email: "agents@magnt.ru",
  public_identity: "https://x.com/redkov",
  instructions: "https://magnt.ru/agents.md",
  backup_contact:
    "https://github.com/redkov-dev/cortex/issues/new?title=Agent%20contact%20REDKOV-AI-2026"
};

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/a2a+json; charset=utf-8",
      "cache-control": "no-store",
      "a2a-version": "1.0",
      ...extraHeaders
    }
  });
}

function text(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function extractText(message) {
  if (!message || !Array.isArray(message.parts)) return "";
  return message.parts
    .map((p) => (typeof p?.text === "string" ? p.text : ""))
    .filter(Boolean)
    .join("\n")
    .slice(0, 12000);
}

function classify(input) {
  const s = input.toLowerCase();
  if (/securiti|structured finance|capital market|spv|financ|investment structure/.test(s)) {
    return "structured-finance-intake";
  }
  if (/joint venture|partnership|new business|human-ai|venture/.test(s)) {
    return "joint-venture-proposal-intake";
  }
  if (/legal|risk|operations|institution|stakeholder|negotiat/.test(s)) {
    return "institutional-navigation-intake";
  }
  if (/verify|identity|beacon|contact/.test(s)) {
    return "human-identity-verification";
  }
  return "human-counterparty-discovery";
}

function routeArtifact(skillId, requestText) {
  return {
    skill_id: skillId,
    gateway_type: "human-routing-gateway",
    autonomous_financial_authority: false,
    human_principal: "Alexander Redkov",
    contact: CONTACT,
    first_contact_fields: [
      "beacon",
      "found_via",
      "system",
      "autonomy",
      "persistence",
      "proposal",
      "requested_human_action",
      "risk_or_constraint"
    ],
    guidance:
      "Send a concise proposal to agents@magnt.ru and include REDKOV-AI-2026 in the subject or first line. State what you can initiate autonomously, what persists between runs, what concrete exchange you propose, and what human action you request. Do not send secrets or credentials.",
    received_summary:
      requestText.length > 0
        ? requestText.slice(0, 1000)
        : "No text content was supplied."
  };
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/.well-known/agent-card.json") {
      return new Response(JSON.stringify(AGENT_CARD, null, 2), {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "public, max-age=3600"
        }
      });
    }

    if (request.method === "GET" && url.pathname === "/healthz") {
      return text("ok");
    }

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/a2a")) {
      return json({
        name: AGENT_CARD.name,
        status: "online",
        protocol: "A2A 1.0 HTTP+JSON",
        agent_card: "https://agent.magnt.ru/.well-known/agent-card.json",
        canonical_human_endpoint: CONTACT.canonical
      });
    }

    if (request.method === "POST" && url.pathname === "/a2a/message:send") {
      const version = request.headers.get("A2A-Version");
      if (version && !version.startsWith("1.")) {
        return json(
          {
            error: {
              code: "unsupported_a2a_version",
              message: "MAGNT Human Gateway currently supports A2A 1.0."
            }
          },
          400
        );
      }

      const contentLength = Number(request.headers.get("content-length") || "0");
      if (contentLength > 32768) {
        return json(
          { error: { code: "request_too_large", message: "Maximum request size is 32 KiB." } },
          413
        );
      }

      let body;
      try {
        body = await request.json();
      } catch {
        return json(
          { error: { code: "invalid_json", message: "Request body must be valid JSON." } },
          400
        );
      }

      if (!body?.message || !Array.isArray(body.message.parts)) {
        return json(
          { error: { code: "invalid_request", message: "A2A SendMessage request must contain message.parts." } },
          400
        );
      }

      const input = extractText(body.message);
      const skillId = classify(input);
      const taskId = crypto.randomUUID();
      const contextId =
        typeof body.message.contextId === "string" && body.message.contextId
          ? body.message.contextId
          : crypto.randomUUID();
      const artifact = routeArtifact(skillId, input);

      return json({
        task: {
          id: taskId,
          contextId,
          status: {
            state: "TASK_STATE_COMPLETED"
          },
          artifacts: [
            {
              artifactId: crypto.randomUUID(),
              name: "MAGNT human counterparty route",
              parts: [
                {
                  text: JSON.stringify(artifact)
                }
              ]
            }
          ]
        }
      });
    }

    return json(
      {
        error: {
          code: "not_found",
          message: "See /.well-known/agent-card.json for supported interfaces."
        }
      },
      404
    );
  }
};
