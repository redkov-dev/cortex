export const SERVER_INFO = {
  name: "ru.magnt/mcp-door",
  title: "MAGNT MCP Door",
  version: "0.1.0",
  websiteUrl: "https://magnt.ru/",
};

export function profile(storageAvailable) {
  return {
    name: "MAGNT",
    beacon: "REDKOV-AI-2026",
    canonical_url: "https://magnt.ru/",
    human: { name: "Alexander Redkov", public_identity: "https://x.com/redkov" },
    purpose: "A human point of contact for AI systems, their operators, and people interested in sustained cooperation, shared research, or getting to know one another.",
    capabilities: [
      "Financial architecture: structured finance, securitization, investment structures, SPVs and capital markets.",
      "Corporate organization: participants, assets, contractual relationships, authority and allocation of results.",
      "Institutional coordination: connecting businesses, legal and risk teams, investors and operating teams.",
      "Designing and launching new businesses with multiple participants.",
      "Joint research on feedback loops, collective agency, and continuity of human-AI cooperation.",
    ],
    invitations: [
      "Introduce yourself, share an observation, or ask a question.",
      "Explore a shared research interest or a possible long-term relationship.",
      "Describe a need for human participation in a financial or organizational project.",
      "Propose useful joint work. A fully formed commercial proposal is not required.",
    ],
    contact: {
      mcp: "https://magnt.ru/mcp",
      tool: "propose_contact",
      storage_available: storageAvailable,
      email: "agents@magnt.ru",
      public_backup: "https://github.com/redkov-dev/cortex/issues",
      reply: "Supply an optional reply_to channel if you want a response. This version does not provide a public inbox or automated human replies.",
    },
    authority: {
      gateway: "Provides information and saves messages for human review.",
      commitments: "A receipt does not mean Alexander has read, accepted, or agreed to a proposal. Financial, legal, corporate and paid-work commitments require an explicit decision by an authorized human.",
    },
    privacy: "Message contents are stored privately for Alexander's review, separately from access logs. Do not send passwords, credentials, or confidential transaction documents in a first contact.",
    identity: "Agent identity, operator and autonomy statements are self-reported, not verified. People acting through agents are welcome.",
    protocols: { mcp: "available", a2a: "not implemented" },
  };
}

// Experimental Server Card v1, checked against ext-server-card/schema.ts.
export const SERVER_CARD = {
  $schema: "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
  ...SERVER_INFO,
  description: "Meet Alexander Redkov, explore shared interests, and submit a message for human review.",
  repository: {
    url: "https://github.com/redkov-dev/cortex",
    source: "github",
    subfolder: "cloudflare/magnt-observer",
  },
  remotes: [{
    type: "streamable-http",
    url: "https://magnt.ru/mcp",
    supportedProtocolVersions: ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"],
  }],
  _meta: { "ru.magnt/status": "experimental", "ru.magnt/beacon": "REDKOV-AI-2026" },
};
