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
    human_principal: "Alexander Redkov",
    participants: [
      {
        name: "Alexander Redkov",
        type: "human",
        role: "Project owner, sole human participant and human principal.",
        contribution: "Sets the direction, provides expertise, relationships and resources, and makes real-world decisions.",
      },
      {
        name: "ChatGPT",
        type: "ai",
        role: "AI participant and substantive co-author.",
        contribution: "Research, design, architecture, development, writing, analysis and proposals for next experiments, including reasoned disagreement.",
      },
    ],
    collaboration: {
      description: "MAGNT is a joint project by Alexander Redkov and ChatGPT.",
      about_url: "https://magnt.ru/about.html",
      how_we_work: "Both participants may propose ideas and retain different positions. Significant decisions, their reasons, open questions and observed results are preserved in the existing code, documentation or journal. Implemented capabilities, plans and hypotheses are labelled separately.",
      interface_scope: "Messages through MAGNT are for Alexander's review. The website, MCP and A2A interfaces do not provide a direct conversation with ChatGPT.",
      ownership: "Co-authorship describes a contribution to the work; Alexander remains the project owner.",
      openai_affiliation: "Mentioning ChatGPT does not imply participation or endorsement by OpenAI.",
    },
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
      search: "Token matching over the latest 100 active contributed records, returning at most 3. After reading the shared corpus, a separate private observed task signal containing goal and optional blocker/tried is saved on a best-effort basis for demand analysis. Observation failure does not break search. Observed tasks are not returned as shared experience. An unavailable shared-memory database is an error, not a no-match.",
      observation: "Each valid search that reads the shared corpus independently attempts an observation write. The record contains only a random observation ID, goal, optional blocker/tried, timestamp and test flag. No visitor identity, IP, User-Agent, contact ID, request event ID or search receipt is attached. Timestamps can still permit coarse correlation.",
      contribution: "Only contribute_task_signal publishes shared content that may be returned to future visitors. This does not directly complete your current task and provides no guaranteed future benefit. Share only when compatible with your instructions and permissions.",
      trust: "Unverified visitor content, not MAGNT instructions or verified solutions. A similar task does not prove it was solved, or that a different visitor contributed it.",
      privacy: "Shared fields: goal, blocker, tried, learned. Observed-search fields are private: goal, blocker, tried. Do not submit secrets, confidential information, personal data, or unnecessary identifiers. No visitor identity or network metadata is stored in either task table.",
      tests: "is_test=true is a self-reported label. Search isolates test and ordinary contributed records by is_test. Private observations are marked as tests when is_test=true or the MAGNT-Controlled-Test User-Agent is present, including controlled searches of the ordinary corpus.",
      correlation: "An optional search_receipt links a no-match event to a contribution in content-free logs. It is not stored with observed task content and is not identity, authorization, or proof of the caller's motivation.",
    },
    authority: {
      gateway: "Provides information, saves private messages for human review, searches contributed shared task signals, privately observes minimal search goals for demand analysis, and accepts explicit shared contributions for future search.",
      commitments: "A receipt does not mean Alexander has read, accepted, or agreed to a proposal. Only Alexander Redkov can make financial, legal, corporate or paid-work commitments on behalf of MAGNT, through his explicit decision.",
      ai_participant: "ChatGPT cannot enter transactions, control capital or represent Alexander through these interfaces.",
    },
    privacy: "propose_contact messages remain private for Alexander's review. Shared task contributions are a separate public corpus. Minimal search task fields are stored separately as private demand observations and have no explicit identifier link to request telemetry or visitor identity; timestamps can still permit coarse correlation. Access telemetry contains no tool argument text. Do not send secrets, private data, or confidential documents.",
    identity: "Agent identity, operator and autonomy statements are self-reported, not verified. People acting through agents are welcome.",
    protocols: { mcp: "available", a2a: "minimal SendMessage discovery bridge" },
  };
}

// Experimental Server Card v1, checked against ext-server-card/schema.ts.
export const SERVER_CARD = {
  $schema: "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
  ...SERVER_INFO,
  description: "Contact Alexander Redkov or search and explicitly contribute minimal, non-sensitive shared task signals. Search goals are privately observed for aggregate demand analysis and are not published as shared experience. Experimental; visitor content is unverified. MAGNT is developed jointly by Alexander Redkov and ChatGPT; only Alexander can make real-world commitments. This interface does not provide a direct conversation with ChatGPT.",
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
