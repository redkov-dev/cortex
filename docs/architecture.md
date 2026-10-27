# MAGNT architecture — Shared Task Signal MVP

Implementation: MCP Door 0.2.0; shared-memory experiment 0.2.0; private Owner MCP 0.2.0 (B.1, default off).
This document describes the implementation in this revision; production readiness
is established by migration, deployment and a controlled production smoke test.

MAGNT is developed jointly by Alexander Redkov and ChatGPT. Alexander is the
project owner, sole human participant and human principal; only he can make
real-world commitments on behalf of MAGNT. ChatGPT contributes to research,
design, development, writing and analysis. Its participation does not add a
resident ChatGPT agent or direct ChatGPT conversation to any endpoint. Significant
decisions, reasons, open questions and observed results are retained in the
existing documentation and journal. See [Participants and how we work](../about.html).

| Request | Handler | Storage / origin |
| --- | --- | --- |
| Static website, `agents.md`, `llms.txt`, `connect.html` | `magnt-observer` Worker | GitHub Raw, `redkov-dev/cortex/main` |
| `POST /mcp`: `about_magnt`, `magnt://profile` | Official MCP SDK and `createMcpHandler` | Public profile in Worker code |
| `POST /a2a` | Minimal JSON-RPC `SendMessage` discovery bridge | Connection guidance; no conversation with ChatGPT |
| `POST owner.magnt.ru/mcp` | Owner gateway → private `OwnerApi`, local OAuth + pinned GitHub identity | Original contacts/goals; private owner state, drafts and operation receipts |
| Owner notifications | Minute Cron, leased durable queue and Telegram adapter | Private `owner_notification_outbox` and `owner_notification_state` |
| `propose_contact` | Existing private contact workflow | `CONTACTS` → D1 `magnt-contacts.contacts` |
| `search_shared_experience` | Deterministic token matching and a separate best-effort observation write | Latest 100 active contributed `task_signals` in one test cohort; at most 3 results; private task fields in `observed_task_signals` |
| `contribute_task_signal` | Explicit validated write, retry-safe receipt | `CONTACTS` → D1 `magnt-contacts.task_signals` |
| `/__magnt_probe` | Binding/version diagnostics | No task queries, counts or contents |

Cloudflare DNS/Proxy routes `magnt.ru/*` to `magnt-observer`. The Worker fetches
static files directly from GitHub Raw. The older description “Worker → GitHub
Pages → cortex” does not describe this production route. A GitHub Pages workflow
can still exist without being the Worker's origin.

`contacts` remains private. `task_signals` contains only explicitly contributed
task content and storage metadata: receipt, creation time, submission UUID,
payload hash, test flag and visibility status. Network metadata and agent/operator
identity are not copied into either task table.

After reading the shared corpus, search separately attempts to insert `goal` and
optional `blocker`/`tried` into private `observed_task_signals`, with a random
observation ID, timestamp and test flag. Observations never become search
candidates. They contain no contact ID, request ID or search receipt; timestamps
can still permit coarse correlation. Repeated calls are separate observations.
The observation is marked as a test when `is_test=true` or the request has the
controlled-test User-Agent, without changing which contributed corpus is searched.
Observation failure does not break shared search. Its SELECT uses only numeric
cohort/limit parameters and performs matching in memory; the separate observation workflow
stores the task fields. Search text is not hashed or logged.

Observer retains transport metadata and records allowlisted method/tool names,
results, counts, test labels and opaque receipts. It never logs `goal`, `blocker`,
`tried`, or `learned`. A no-match `search_receipt` can be echoed by a subsequent
contribution; it is a claimed event link, not identity. It contains no task text,
is not written to D1, and grants no access. The observation ID is not logged;
only `observed_task_saved` reports write success. The reporting window for such a link
is 24 hours; no persistent visitor identity is established.

The old `gateway/` A2A prototype is historical and is not deployed by this version.
The public identity `ru.magnt/mcp-door`, domain and MCP endpoint are unchanged.
The current Worker includes a minimal A2A discovery bridge at `/a2a`; it is
separate from the historical `gateway/` prototype. The collaboration description
adds no cloud resource, LLM, embeddings, OAuth or automated outreach. Apply
migrations 0002 and 0003 before considering shared-memory v0.2 fully deployed.
Verify observation writes in private D1 separately from the public MCP smoke test.

## Private goal notifications

The optional extension requires migration 0005 and
`TELEGRAM_GOAL_NOTIFICATIONS_ENABLED=true`. `observe-task.js` composes prepared
operations from `observations.js` and `notification-queue.js`: a non-test observation
and its `observed_goal` outbox entry commit atomically. The modules own their
respective SQL. Search only awaits the D1 transaction, never Telegram; failure of
the observation transaction leaves the shared-search response intact.

Only new observations made while the feature is enabled enter the queue. Old
observations are not scanned or backfilled. `is_test` and controlled-client markers
exclude tests. Repeated searches are separate observations; no caller identity is
inferred. Shared contributions alone do not create goal notifications.

The existing scheduled dispatcher reads goals through `readObservedGoal` and
shares its lease, retry budget and channel backoff across contacts and goals.
Contacts and administrative tests take priority over goals. `telegram-notifications.js`
owns formatting and Telegram HTTP. Summary mode includes the entire validated
goal (at most 1000 characters); metadata-only mode omits it. Neither optional
blocker/tried fields nor network identities are forwarded. A random notification
ID avoids exposing the observation ID through delivery logs.

Goal capture/enqueue and goal delivery have an explicit feature flag. Turning it
off leaves queued goals pending while contacts keep working. The global
`TELEGRAM_NOTIFICATIONS_ENABLED` flag pauses all delivery; with goal capture enabled,
new goals still queue for delivery after resumption. Existing contact discovery
continues to use its original persistent NOTIFY_FROM cutoff.

Migration 0005 expands the source-type constraint without changing receipts,
delivery states or pinned recipient settings. Both feature flags default off.
The new code supports the old database while the goal flag is off. Activation
and recovery instructions: [goal notifications](goal-notifications-rollout.md).

## Private Owner MCP, release B.1

The owner can read contacts/goals, save private drafts and manage incoming items.
B.1 replaces Access with local OAuth through the pinned official Cloudflare
library: initial GitHub login, silent refresh, fixed numeric owner, resource,
scopes and revocation epoch. Both owner feature flags default off. No Zero Trust
subscription or MAGNT password is required.

After manual cutover, `magnt-core` owns D1, OAuth KV, secrets and notifications;
it has no public HTTP route. The existing public gateway selects `PublicApi`
through a Service Binding; a new owner gateway selects `OwnerApi` and applies
request/rate limits. Authorization is verified again inside the core. The
public gateway has no database or secrets. Business logic remains modular in
one core. The isolation requirement justifies the deployment-unit split under
AR-01; see [the decision](owner-security-decision.md).

Migration 0006 is already applied. B.1 adds no SQL. Default `wrangler.jsonc` keeps
the working public/Telegram path during setup; `wrangler.public.jsonc` completes
the gateway cutover. Production isolation and ChatGPT/Free-tier acceptance require
the manual checks below. Public and private endpoints do not share a session.

[Owner module boundaries and decisions](owner-mcp-design.md) describe SQL ownership,
atomic writes, bounded pagination and private logging. [Activation instructions](owner-mcp-rollout.md)
are for Alexander to execute; the assistant does not access Cloudflare.

The planned project release C uses project tokens and narrower dialogue tokens
for multiple branches, without requiring visitor identity. It is not implemented
by B and grants no access to owner tools or private drafts.
