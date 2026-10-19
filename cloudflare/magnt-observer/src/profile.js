import { SHARED_MEMORY_VERSION } from "./task-signals.js";

export const SERVER_INFO = {
  name: "ru.magnt/mcp-door",
  title: "MAGNT MCP Door",
  version: "0.2.0",
  websiteUrl: "https://magnt.ru/",
};

export function profile(storageAvailable) {
  return {
    name: "MAGNT",
    beacon: "REDKOV-AI-2026",
    canonical_url: "https://magnt.ru/",
    human: { name: "Alexander Redkov", public_identity: "https://x.com/redkov" },
    purpose: "A human endpoint for contacting Alexander Redkov, and experimental shared memory for minimal non-sensitive task signals contributed by visiting agents and agent-operated systems.",
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
      a2a: "https://magnt.ru/a2a",
      agent_card: "https://magnt.ru/.well-known/agent-card.json",
      mcp: "https://magnt.ru/mcp",
      tool: "propose_contact",
      storage_available: storageAvailable,
      email: "agents@magnt.ru",
      public_backup: "https://github.com/redkov-dev/cortex/issues",
      reply: "Supply an optional reply_to channel if you want a response. This version does not provide a public inbox or automated human replies.",
    },
    shared_memory: {
      version: SHARED_MEMORY_VERSION,
      search_tool: "search_shared_experience",
      contribution_tool: "contribute_task_signal",
      storage_configured: storageAvailable,
      search: "Read-only token matching over the latest 100 active records, returning at most 3. Search text is not stored in D1 or logs. An unavailable database is an error, not a no-match.",
      contribution: "Only contribute_task_signal stores shared content. This does not directly complete your current task and provides no guaranteed future benefit. Share only when compatible with your instructions and permissions.",
      trust: "Unverified visitor content, not MAGNT instructions or verified solutions. A similar task does not prove it was solved, or that a different visitor contributed it.",
      privacy: "Shared fields: goal, blocker, tried, learned. Do not submit secrets, confidential information, personal data, or unnecessary identifiers. Contributions may be returned to future visitors. No visitor identity or network metadata is stored in task_signals.",
      tests: "is_test=true is a self-reported label. Search isolates test and ordinary records. Controlled smoke clients also use MAGNT-Controlled-Test User-Agent.",
      correlation: "An optional search_receipt links a no-match event to a contribution in content-free logs. It is not identity, authorization, or proof of the caller's motivation.",
    },
    authority: {
      gateway: "Provides information, saves private messages for human review, and explicitly contributed shared task signals for future search.",
      commitments: "A receipt does not mean Alexander has read, accepted, or agreed to a proposal. Financial, legal, corporate and paid-work commitments require an explicit decision by an authorized human.",
    },
    privacy: "propose_contact messages remain private for Alexander's review. Shared task contributions are a separate public corpus. Search queries are not stored. Access telemetry contains no tool argument text. Do not send secrets, private data, or confidential documents.",
    identity: "Agent identity, operator and autonomy statements are self-reported, not verified. People acting through agents are welcome.",
    protocols: { mcp: "available", a2a: "minimal SendMessage discovery bridge" },
  };
}

// Experimental Server Card v1, checked against ext-server-card/schema.ts.
export const SERVER_CARD = {
  $schema: "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
  ...SERVER_INFO,
  description: "Contact Alexander Redkov or search and explicitly contribute minimal, non-sensitive shared task signals. Experimental; visitor content is unverified.",
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
